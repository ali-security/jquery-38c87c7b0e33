/*
 * Headless runner for the jQuery QUnit suite (test/index.html).
 *
 * Opens the default test page (every module listed in test/data/testinit.js,
 * against dist/jquery.min.js) in headless Chrome, prints one line per test
 * plus the failing assertions, and exits non-zero when any test fails or
 * when QUnit does not finish within the timeout.
 *
 * The page must be served by a PHP-capable server rooted at the repo root
 * (the ajax tests hit test/data/*.php), e.g.:
 *   php -S localhost:8000 -t .
 *
 * Needs Node >= 18 and puppeteer-core (resolved via NODE_PATH).
 *
 * Environment:
 *   TEST_URL      page to open (default http://localhost:8000/test/index.html)
 *   CHROME_BIN    Chrome executable (default: first of google-chrome, chromium on PATH)
 *   TEST_TIMEOUT  overall timeout in ms (default 25 minutes)
 */
/* jshint node: true */
/* global Promise: false */

var childProcess = require( "child_process" ),
	puppeteer = require( "puppeteer-core" ),
	testUrl = process.env.TEST_URL || "http://localhost:8000/test/index.html",
	timeoutMs = parseInt( process.env.TEST_TIMEOUT, 10 ) || 25 * 60 * 1000;

function findChrome() {
	var i, out,
		candidates = [ "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" ];

	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	for ( i = 0; i < candidates.length; i++ ) {
		try {
			out = childProcess.execSync( "which " + candidates[ i ],
				{ stdio: [ "ignore", "pipe", "ignore" ] } ).toString().trim();
		} catch ( e ) {
			out = "";
		}
		if ( out ) {
			return out;
		}
	}
	throw new Error( "Chrome not found: set CHROME_BIN or install google-chrome" );
}

// Runs inside the page (top frame only) before any page script.
// Traps the `window.QUnit = QUnit` assignment at the end of qunit.js and
// registers the logging callbacks there, i.e. before testinit.js's
// loadTests() calls QUnit.start() (QUnit.config.autostart is false).
function installHooks() {
	var report = function( msg ) {
		window.__qunitReport( msg );
	};

	function hook( QUnit ) {
		var failures = [];

		QUnit.testStart(function( details ) {
			failures = [];
			report({ type: "testStart", module: details.module, name: details.name });
		});
		QUnit.log(function( details ) {
			var msg;

			if ( details.result ) {
				return;
			}
			msg = String( details.message === undefined ? "(no message)" : details.message );
			if ( details.hasOwnProperty( "expected" ) ) {
				msg += " | expected: " + QUnit.jsDump.parse( details.expected ) +
					" | actual: " + QUnit.jsDump.parse( details.actual );
			}
			if ( details.source ) {
				msg += " | " + String( details.source ).split( "\n" )[ 0 ].replace( /^\s+/, "" );
			}
			failures.push( msg );
		});
		QUnit.testDone(function( details ) {
			report({
				type: "testDone",
				module: details.module,
				name: details.name,
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				failures: failures
			});
			failures = [];
		});
		QUnit.done(function( details ) {
			report({
				type: "done",
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime
			});
		});
	}

	if ( window.top !== window ) {
		return;
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return undefined;
		},
		set: function( value ) {
			// Replace the trap with a plain property, then hook once
			Object.defineProperty( window, "QUnit", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: value
			});
			hook( value );
		}
	});
}

function main() {
	var browser, page, finished, timer, heartbeat,
		current = null,
		tests = { total: 0, passed: 0, failed: 0 },
		startedAt = Date.now(),
		done = new Promise(function( resolve ) {
			finished = resolve;
		});

	function onReport( msg ) {
		var i;

		if ( msg.type === "testStart" ) {
			current = msg.module + " :: " + msg.name;
		} else if ( msg.type === "testDone" ) {
			current = null;
			tests.total++;
			if ( msg.failed > 0 ) {
				tests.failed++;
			} else {
				tests.passed++;
			}
			console.log( ( msg.failed > 0 ? "FAIL " : "PASS " ) + msg.module + " :: " + msg.name +
				" (" + msg.passed + "/" + msg.total + " assertions)" );
			for ( i = 0; msg.failed > 0 && i < msg.failures.length; i++ ) {
				console.log( "    - " + msg.failures[ i ] );
			}
		} else if ( msg.type === "done" ) {
			finished( msg );
		}
	}

	function closeBrowser( code ) {
		if ( !browser ) {
			return code;
		}
		return browser.close().then(function() {
			return code;
		}, function() {
			return code;
		});
	}

	return puppeteer.launch({
		executablePath: findChrome(),
		headless: "new",
		args: [ "--no-sandbox", "--disable-dev-shm-usage" ]
	}).then(function( b ) {
		browser = b;
		return browser.newPage();
	}).then(function( p ) {
		page = p;
		page.setDefaultNavigationTimeout( 120000 );
		page.on( "console", function( m ) {
			if ( m.type() === "error" ) {
				console.log( "[page console.error] " + m.text() );
			}
		});
		page.on( "pageerror", function( err ) {
			console.log( "[page error] " + ( err && err.message || err ) );
		});
		page.on( "error", function( err ) {
			console.log( "[page crashed] " + ( err && err.message || err ) );
			finished( null );
		});
		return page.exposeFunction( "__qunitReport", onReport );
	}).then(function() {
		return page.evaluateOnNewDocument( installHooks );
	}).then(function() {
		console.log( "Opening " + testUrl );
		return page[ "goto" ]( testUrl, { waitUntil: "load" } );
	}).then(function() {
		var timeout = new Promise(function( resolve ) {
			timer = setTimeout(function() {
				resolve( null );
			}, timeoutMs );
		});

		// Keep the CI log alive and show where a slow run is
		heartbeat = setInterval(function() {
			console.log( "... still running (" + Math.round( ( Date.now() - startedAt ) / 1000 ) +
				"s, " + tests.total + " tests done" + ( current ? ", current: " + current : "" ) + ")" );
		}, 60000 );

		return Promise.race( [ done, timeout ] );
	}).then(function( result ) {
		var code = 0;

		clearTimeout( timer );
		clearInterval( heartbeat );

		if ( !result ) {
			console.log( "QUnit did not finish within " + timeoutMs + "ms" +
				( current ? " (stuck in: " + current + ")" : "" ) );
			console.log( "QUnit summary (incomplete): " + tests.total + " tests, " +
				tests.passed + " passed, " + tests.failed + " failed" );
			code = 2;
		} else {
			console.log( "QUnit summary: " + tests.total + " tests, " + tests.passed + " passed, " +
				tests.failed + " failed; assertions " + result.passed + " passed / " +
				result.failed + " failed / " + result.total + " total; runtime " +
				result.runtime + "ms" );
			if ( result.failed > 0 || tests.failed > 0 ) {
				code = 1;
			} else if ( result.total === 0 || tests.total === 0 ) {
				console.log( "No tests ran" );
				code = 1;
			}
		}
		return closeBrowser( code );
	}).then( null, function( err ) {
		clearTimeout( timer );
		clearInterval( heartbeat );
		console.log( "Runner error: " + ( err && err.stack || err ) );
		return closeBrowser( 2 );
	});
}

main().then(function( code ) {
	process.exit( code );
});
