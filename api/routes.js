'use strict';
require('../lib/core-upgrade.js');

var path = require('path');
var fs = require('fs');
var qs = require('querystring');
var url = require('url');
var util = require('util');
var childProcess = require('child_process');
var cluster = require('cluster');
var domino = require('domino');
var pkg = require('../package.json');
var apiUtils = require('./utils');

var MWParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var LogData = require('../lib/LogData.js').LogData;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var ApiRequest = require('../lib/mediawiki.ApiRequest.js');
var Diff = require('../lib/mediawiki.Diff.js').Diff;

var ParsoidCacheRequest = ApiRequest.ParsoidCacheRequest;
var TemplateRequest = ApiRequest.TemplateRequest;
var PHPParseRequest = ApiRequest.PHPParseRequest;
var PegTokenizer = require('../lib/mediawiki.tokenizer.peg.js').PegTokenizer;

module.exports = function(parsoidConfig) {
	var routes = {};

	/**
	 * Timeouts
	 *
	 * The request timeout is a simple node timer that should fire first and catch
	 * most cases where we have long running requests to optimize.
	 *
	 * The CPU timeout handles the case where a child process is starved in a CPU
	 * bound task for too long and doesn't give node a chance to fire the above
	 * timer. At the beginning of each request, the child sends a message to the
	 * cluster master containing a request id. If the master doesn't get a second
	 * message from the child with the corresponding id by CPU_TIMEOUT, it will
	 * send the SIGKILL signal to the child process.
	 *
	 * The above is susceptible false positives. Node spins one event loop, so
	 * multiple asynchronous requests will interfere with each others' timing.
	 */

	var REQ_TIMEOUT = parsoidConfig.timeouts.request;
	var CPU_TIMEOUT = parsoidConfig.timeouts.cpu;

	function timeoutResp( env, err ) {
		if ( err instanceof Promise.TimeoutError ) {
			err = new Error("Request timed out.");
			err.stack = null;
		}
		env.log("fatal/request", err);
	}

	var makeDone = function( timeoutId ) {
		// Create this function in an outer scope so that we don't inadvertently
		// keep a reference to the promise here.
		return function() {
			process.send({ type: "timeout", done: true, timeoutId: timeoutId });
		};
	};

	// Cluster support was very experimental and missing methods in v0.8.x
	var sufficientNodeVersion = !/^v0\.[0-8]\./.test( process.version );

	var cpuTimeout = function( p, res ) {
		var timeoutId = res.local("timeoutId");
		var location = util.format(
			"[%s/%s%s]", res.local("iwp"), res.local("pageName"),
			(res.local("oldid") ? "?oldid=" + res.local("oldid") : "")
		);
		return new Promise(function( resolve, reject ) {
			if ( cluster.isMaster || !sufficientNodeVersion ) {
				return p.then( resolve, reject );
			}
			// Notify the cluster master that a request has started
			// to wait for a corresponding done msg or timeout.
			process.send({
				type: "timeout",
				timeout: CPU_TIMEOUT,
				timeoutId: timeoutId,
				location: location
			});
			var done = makeDone( timeoutId );
			p.then( done, done );
			p.then( resolve, reject );
		});
	};

	// Helpers

	var logTime = function( env, res, str ) {
		env.log( "info", util.format(
			"completed %s in %s ms", str, Date.now() - res.local("start")
		) );
	};

	var rtResponse = function( env, req, res, data ) {
		apiUtils.renderResponse( res, env, "roundtrip", data );
		logTime( env, res, "parsing" );
	};

	var roundTripDiff = function(env, req, res, useSelser, doc) {
		// Re-parse the HTML to uncover foster-parenting issues
		doc = domino.createDocument(doc.outerHTML);

		return DU.serializeDOM(env, doc.body, useSelser).then(function(out) {
			// Strip selser trigger comment
			out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

			// Emit base href so all relative urls resolve properly
			var hNodes = doc.head.childNodes;
			var headNodes = "";
			for (var i = 0; i < hNodes.length; i++) {
				if (hNodes[i].nodeName.toLowerCase() === 'base') {
					headNodes += DU.serializeNode(hNodes[i]).str;
					break;
				}
			}

			var bNodes = doc.body.childNodes;
			var bodyNodes = "";
			for (i = 0; i < bNodes.length; i++) {
				bodyNodes += DU.serializeNode(bNodes[i]).str;
			}

			var htmlSpeChars = apiUtils.htmlSpecialChars(out);
			var patch = Diff.convertChangesToXML(Diff.diffLines(env.page.src, out));

			return {
				headers: headNodes,
				bodyNodes: bodyNodes,
				htmlSpeChars: htmlSpeChars,
				patch: patch,
				reqUrl: req.url
			};
		});
	};

	var parse = function( env, req, res ) {
		env.log('info', 'started parsing');

		var meta = env.page.meta;
		var v2 = res.local('v2');
		var p = Promise.resolve();

		// See if we can reuse transclusion or extension expansions.
		if ( v2 && ( v2.previous || v2.original ) ) {
			p = p.then(function() {
				var revision = v2.previous || v2.original;
				var doc = DU.parseHTML( revision.html.body );
				DU.applyDataParsoid( doc, revision["data-parsoid"].body );
				var ret = {
					expansions: DU.extractExpansions( doc )
				};
				if ( v2.update ) {
					["templates", "files"].some(function(m) {
						if ( v2.update[m] ) {
							ret.mode = m;
							return true;
						}
					});
				}
				return ret;
			});
		// And don't parse twice for recursive parsoid requests.
		} else if ( env.conf.parsoid.parsoidCacheURI && !req.headers['x-parsoid-request'] ) {
			p = p.then(function() {
				// Try to retrieve a cached copy of the content.
				var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
				// If a cacheID is passed in X-Parsoid (from our PHP extension),
				// use that explicitly. Otherwise default to the parentID.
				var cacheID = parsoidHeader.cacheID || meta.revision.parentid;
				return ParsoidCacheRequest
					.promise(env, meta.title, cacheID)
					.then(function(src) {
						// Extract transclusion and extension content from the DOM
						var ret = {
							expansions: DU.extractExpansions(DU.parseHTML(src))
						};
						if (parsoidHeader.cacheID) {
							ret.mode = parsoidHeader.mode;
						}
						return ret;
					}, function(err) {
						// No luck with the cache request.
						return null;
					});
			});
		}

		return p.then(function( ret ) {
			if ( ret ) {
				// Figure out what we can reuse
				switch ( ret.mode ) {
				case "templates":
					// Transclusions need to be updated, so don't reuse them.
					ret.expansions.transclusions = {};
					break;
				case "files":
					// Files need to be updated, so don't reuse them.
					ret.expansions.files = {};
					break;
				}
			}
			return env.pipelineFactory.parse(env, env.page.src, ret && ret.expansions);
		});
	};

	var html2wt = function(req, res, html) {
		var env = res.local('env');
		var v2 = res.local('v2');

		env.page.id = res.local('oldid');
		env.log('info', 'started serializing');

		if (v2 && v2.original && v2.original.wikitext) {
			env.setPageSrcInfo(v2.original.wikitext.body);
		}

		// Performance Timing options
		var timer = env.conf.parsoid.performanceTimer;
		var startTimers;

		if (timer) {
			startTimers = new Map();
			startTimers.set('html2wt.init', Date.now());
			startTimers.set('html2wt.total', Date.now());
		}

		if (env.conf.parsoid.allowCORS) {
			// Allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites.
			apiUtils.setHeader(res, env, 'Access-Control-Allow-Origin',
				env.conf.parsoid.allowCORS );
		}

		if (timer) {
			startTimers.set('html2wt.init.domparse', Date.now());
		}

		var doc = DU.parseHTML(html);

		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed from html string to DOM tree
		if (timer) {
			timer.timing('html2wt.init.domparse', '',
				Date.now() - startTimers.get('html2wt.init.domparse'));
			timer.timing('html2wt.size.input', '', html.length);
			timer.timing('html2wt.init', '',
				Date.now() - startTimers.get( 'html2wt.init' ));
		}

		if (v2 && v2.original && v2.original["data-parsoid"]) {
			DU.applyDataParsoid(doc, v2.original["data-parsoid"].body);
		}

		if (v2 && v2.original && v2.original.html) {
			env.page.dom = DU.parseHTML(v2.original.html.body).body;
			if (v2.original["data-parsoid"]) {
				DU.applyDataParsoid(env.page.dom.ownerDocument,
					v2.original["data-parsoid"].body);
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		var hasOldId = (env.page.id && env.page.id !== '0');
		var useSelser = hasOldId && parsoidConfig.useSelser;
		var p = DU.serializeDOM(env, doc.body, useSelser)
			.timeout(REQ_TIMEOUT)
			.then(function(output) {
			var contentType = 'text/plain;profile=mediawiki.org/specs/wikitext/1.0.0;charset=utf-8';
			if (v2) {
				apiUtils.jsonResponse(res, env, {
					wikitext: {
						headers: { 'content-type': contentType },
						body: output,
					}
				});
			} else {
				apiUtils.setHeader(res, env, 'content-type', contentType);
				apiUtils.endResponse(res, env, output);
			}

			if (timer) {
				timer.timing('html2wt.total', '',
					Date.now() - startTimers.get('html2wt.total'));
				timer.timing('html2wt.size.output', '', output.length);
			}

			logTime(env, res, "serializing");
		});
		return cpuTimeout(p, res)
			.catch(timeoutResp.bind(null, env));
	};

	var wt2html = function(req, res, wt) {
		var env = res.local('env');

		// Performance Timing options
		var timer = env.conf.parsoid.performanceTimer;
		var startTimers;

		if (timer) {
			startTimers = new Map();
			// init refers to time elapsed before parsing begins
			startTimers.set('wt2html.init', Date.now());
			startTimers.set('wt2html.total', Date.now());
		}

		var prefix = res.local('iwp');
		var oldid = res.local('oldid');
		var v2 = res.local('v2');
		var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');

		if ( env.conf.parsoid.allowCORS ) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			apiUtils.setHeader( res, env, 'Access-Control-Allow-Origin',
								env.conf.parsoid.allowCORS );
		}

		function sendRes(doc) {
			var contentType = 'text/html;profile=mediawiki.org/specs/html/1.0.0;charset=utf-8';
			var output;
			if (v2 && v2.format === 'pagebundle') {
				var out = DU.extractDpAndSerialize(doc, res.local('body'));
				output = out.str;
				apiUtils.jsonResponse(res, env, {
					// revid: 12345 (maybe?),
					html: {
						headers: { 'content-type': contentType },
						body: output
					},
					"data-parsoid": {
						headers: { 'content-type': out.type },
						body: out.dp
					}
				});
			} else {
				output = DU.serializeNode(res.local('body') ? doc.body : doc).str;
				apiUtils.setHeader(res, env, 'content-type', contentType);
				apiUtils.endResponse(res, env, output);
			}

			if ( timer ) {
				if ( startTimers.has( 'wt2html.wt.parse' ) ) {
					timer.timing( 'wt2html.wt.parse', '',
						Date.now() - startTimers.get( 'wt2html.wt.parse' ));
					timer.timing( 'wt2html.wt.size.output', '', output.length );
				} else if ( startTimers.has( 'wt2html.pageWithOldid.parse' ) ) {
					timer.timing( 'wt2html.pageWithOldid.parse', '',
						Date.now() - startTimers.get( 'wt2html.pageWithOldid.parse' ));
					timer.timing( 'wt2html.pageWithOldid.size.output', '', output.length );
				}
				timer.timing( 'wt2html.total', '',
					Date.now() - startTimers.get( 'wt2html.total' ));
			}

			logTime( env, res, "parsing" );
		}

		function parseWt() {
			env.log('info', 'started parsing');
			env.setPageSrcInfo(wt);

			// Don't cache requests when wt is set in case somebody uses
			// GET for wikitext parsing
			apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');

			if (timer) {
				timer.timing('wt2html.wt.init', '',
					Date.now() - startTimers.get( 'wt2html.init'));
				startTimers.set('wt2html.wt.parse', Date.now());
				timer.timing('wt2html.wt.size.input', '', wt.length);
			}

			if (!res.local('pageName')) {
				// clear default page name
				env.page.name = '';
			}

			return env.pipelineFactory.parse(env, wt);
		}

		function parsePageWithOldid() {
			if ( timer ) {
				timer.timing( 'wt2html.pageWithOldid.init', '',
					Date.now() - startTimers.get( 'wt2html.init' ));
				startTimers.set( 'wt2html.pageWithOldid.parse', Date.now() );
				timer.timing('wt2html.pageWithOldid.size.input', '', env.page.src.length );
			}

			return parse( env, req, res ).then(function( doc ) {
				if ( req.headers.cookie || v2 ) {
					// Don't cache requests with a session.
					// Also don't cache requests to the v2 entry point, as those
					// are stored by RESTBase & will just dilute the Varnish cache
					// in the meantime.
					apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
				} else {
					apiUtils.setHeader(res, env, 'Cache-Control', 's-maxage=2592000');
				}
				// Indicate the MediaWiki revision in a header as well for
				// ease of extraction in clients.
				apiUtils.setHeader(res, env, 'content-revision-id', oldid);
				return doc;
			});
		}

		function redirectToOldid() {
			// Don't cache requests with no oldid
			apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
			oldid = env.page.meta.revision.revid;
			env.log("info", "redirecting to revision", oldid);

			if ( timer ) {
				timer.count('wt2html.redirectToOldid', '');
			}

			var path = "/";
			if ( v2 ) {
				path += [
					"v2",
					url.parse(env.conf.parsoid.mwApiMap.get(prefix).uri).host,
					v2.format,
					encodeURIComponent( target ),
					oldid
				].join("/");
			} else {
				path += [
					prefix,
					encodeURIComponent( target )
				].join("/");
				req.query.oldid = oldid;
			}

			if ( Object.keys( req.query ).length > 0 ) {
				path += "?" + qs.stringify( req.query );
			}

			// Redirect to oldid
			apiUtils.relativeRedirect({ "path": path, "res": res, "env": env });
		}

		// To support the 'subst' API parameter, we need to prefix each
		// top-level template with 'subst'. To make sure we do this for the
		// correct templates, tokenize the starting wikitext and use that to
		// detect top-level templates. Then, substitute each starting '{{' with
		// '{{subst' using the template token's tsr.
		function substTopLevelTemplates(p) {
			var tokenizer = new PegTokenizer(env);
			var tokens = tokenizer.tokenize(wt, null, null, true);
			var tsrIncr = 0;
			for (var i = 0; i < tokens.length; i++) {
				if (tokens[i].name === 'template') {
					var tsr = tokens[i].dataAttribs.tsr;
					wt = wt.substring(0, tsr[0] + tsrIncr) +
						'{{subst:' +
						wt.substring(tsr[0] + tsrIncr + 2);
					tsrIncr += 6;
				}
			}
			// Now pass it to the MediaWiki API with onlypst set so that it
			// subst's the templates.
			return p.then(function() {
				return PHPParseRequest.promise(env, target, wt, true);
			}).then(function(text) {
				// Use the returned wikitext as the page source.
				wt = text;
				// Set data-parsoid to be discarded, so that the subst'ed
				// content is considered new when it comes back.
				env.discardDataParsoid = true;
			});
		}

		var p;
		if (oldid || typeof wt !== 'string') {
			// Always fetch the page info if we have an oldid.
			// Otherwise, if no wt was passed, we need to figure out
			// the latest revid to which we'll redirect.
			p = TemplateRequest.setPageSrcInfo(env, target, oldid);
		} else {
			p = Promise.resolve();
		}

		if (typeof wt === 'string') {
			if (res.local('subst')) {
				p = substTopLevelTemplates(p);
			}
			p = p.then(parseWt)
				.timeout(REQ_TIMEOUT)
				.then(sendRes);
		} else if (oldid) {
			p = p.then(parsePageWithOldid)
				.timeout(REQ_TIMEOUT)
				.then(sendRes);
		} else {
			p = p.then(redirectToOldid);
		}

		return cpuTimeout(p, res)
			.catch(timeoutResp.bind(null, env));
	};

	// Middlewares

	routes.interParams = function( req, res, next ) {
		res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
		res.local('pageName', req.params[1] || '');
		res.local('oldid', req.body.oldid || req.query.oldid || null);
		// "body" flag to return just the body (instead of the entire HTML doc)
		res.local('body', !!(req.query.body || req.body.body));
		// "subst" flag to perform {{subst:}} template expansion
		res.local('subst', !!(req.query.subst || req.body.subst));
		next();
	};

	routes.parserEnvMw = function( req, res, next ) {
		function errBack( env, logData, callback ) {
			if ( !env.responseSent ) {
				return new Promise(function( resolve, reject ) {
					var socket = res.socket;
					if ( res.finished || (socket && !socket.writable) ) {
						return resolve();
					}
					res.once( 'finish', resolve );
					apiUtils.setHeader( res, env, 'content-type', 'text/plain;charset=utf-8' );
					apiUtils.sendResponse( res, env, logData.fullMsg(), logData.flatLogObject().code || 500 );
				}).catch(function(e) {
					console.error( e.stack || e );
					res.end( e.stack || e );
				}).nodify(callback);
			}
			return Promise.resolve().nodify(callback);
		}
		var options = {
			prefix: res.local('iwp'),
			pageName: res.local('pageName'),
			cookie: req.headers.cookie,
			reqId: req.headers['x-request-id']
		};
		MWParserEnv.getParserEnv(parsoidConfig, null, options).then(function(env) {
			env.logger.registerBackend(/fatal(\/.*)?/, errBack.bind(this, env));
			if (res.local('v2') && res.local('v2').format === 'pagebundle') {
				env.storeDataParsoid = true;
			}
			if (req.body.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.body.scrubWikitext ||
					req.body.scrubWikitext === "false");
			} else if (req.query.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.query.scrubWikitext ||
					req.query.scrubWikitext === "false");
			}
			res.local('env', env);
			next();
		}).catch(function(err) {
			// Workaround how logdata flatten works so that the error object is
			// recursively flattened and a stack trace generated for this.
			errBack({}, new LogData('error', ['error:', err, 'path:', req.path]));
		});
	};

	// Routes

	routes.home = function( req, res ) {
		res.render('home');
	};

	// robots.txt: no indexing.
	routes.robots = function( req, res ) {
		res.end("User-agent: *\nDisallow: /\n");
	};

	// Return Parsoid version based on package.json + git sha1 if available
	var versionCache;
	routes.version = function( req, res ) {
		if ( !versionCache ) {
			versionCache = Promise.resolve({
				name: pkg.name,
				version: pkg.version
			}).then(function( v ) {
				return Promise.promisify(
					childProcess.execFile, ['stdout', 'stderr'], childProcess
				)( 'git', ['rev-parse', 'HEAD'], {
					cwd: path.join(__dirname, '..')
				}).then(function( out ) {
					v.sha = out.stdout.slice(0, -1);
					return v;
				}, function( err ) {
					/* ignore the error, maybe this isn't a git checkout */
					return v;
				});
			});
		}
		return versionCache.then(function( v ) {
			res.json( v );
		});
	};

	// Redirects for old-style URL compatibility
	routes.redirectOldStyle = function( req, res ) {
		if ( req.params[0] ) {
			apiUtils.relativeRedirect({
				"path": '/' + req.params[0] + req.params[1] + '/' + req.params[2],
				"res": res,
				"code": 301
			});
		} else {
			apiUtils.relativeRedirect({
				"path": '/' + req.params[1] + '/' + req.params[2],
				"res": res,
				"code": 301
			});
		}
		res.end();
	};

	// Form-based HTML DOM -> wikitext interface for manual testing.
	routes.html2wtForm = function( req, res ) {
		var env = res.local('env');
		var action = "/" + res.local('iwp') + "/" + res.local('pageName');
		if (req.query.hasOwnProperty('scrubWikitext')) {
			action += "?scrubWikitext=" + req.query.scrubWikitext;
		}
		apiUtils.renderResponse(res, env, "form", {
			title: "Your HTML DOM:",
			action: action,
			name: "html"
		});
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	routes.wt2htmlForm = function( req, res ) {
		var env = res.local('env');
		apiUtils.renderResponse(res, env, "form", {
			title: "Your wikitext:",
			action: "/" + res.local('iwp') + "/" + res.local('pageName'),
			name: "wt"
		});
	};

	// Round-trip article testing.  Default to scrubbing wikitext here.  Can be
	// overridden with qs param.
	routes.roundtripTesting = function( req, res ) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(
			parse.bind( null, env, req, res )
		).then(
			roundTripDiff.bind( null, env, req, res, false )
		).timeout( REQ_TIMEOUT ).then(
			rtResponse.bind( null, env, req, res )
		);

		cpuTimeout( p, res )
			.catch( timeoutResp.bind(null, env) );
	};

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation.  Default to scrubbing wikitext here.  Can be overridden with qs
	// param.
	routes.roundtripTestingNL = function( req, res ) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(
			parse.bind( null, env, req, res )
		).then(function( doc ) {
			// strip newlines from the html
			var html = doc.innerHTML.replace(/[\r\n]/g, '');
			return roundTripDiff( env, req, res, false, DU.parseHTML(html) );
		}).timeout( REQ_TIMEOUT ).then(
			rtResponse.bind( null, env, req, res )
		);

		cpuTimeout( p, res )
			.catch( timeoutResp.bind(null, env) );
	};

	// Round-trip article testing with selser over re-parsed HTML.  Default to
	// scrubbing wikitext here.  Can be overridden with qs param.
	routes.roundtripSelser = function( req, res ) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(
			parse.bind( null, env, req, res )
		).then(function( doc ) {
			doc = DU.parseHTML(DU.serializeNode(doc).str);
			var comment = doc.createComment('rtSelserEditTestComment');
			doc.body.appendChild(comment);
			return roundTripDiff( env, req, res, true, doc );
		}).timeout( REQ_TIMEOUT ).then(
			rtResponse.bind( null, env, req, res )
		);

		cpuTimeout( p, res )
			.catch( timeoutResp.bind(null, env) );
	};

	// Form-based round-tripping for manual testing
	routes.getRtForm = function( req, res ) {
		var env = res.local('env');
		apiUtils.renderResponse(res, env, "form", {
			title: "Your wikitext:",
			name: "content"
		});
	};

	// Form-based round-tripping for manual testing.  Default to scrubbing wikitext
	// here.  Can be overridden with qs param.
	routes.postRtForm = function( req, res ) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
			env.scrubWikitext = true;
		}

		env.setPageSrcInfo(req.body.content);

		parse( env, req, res ).then(
			roundTripDiff.bind( null, env, req, res, false )
		).then(
			rtResponse.bind( null, env, req, res )
		).catch(function(err) {
			env.log("fatal/request", err);
		});
	};

	routes.getArticle = function( req, res ) {
		// Regular article parsing
		wt2html( req, res );
	};

	routes.postArticle = function( req, res ) {
		var body = req.body;
		if ( req.body.wt ) {
			// Form-based article parsing
			wt2html( req, res, body.wt );
		} else {
			// Regular and form-based article serialization
			html2wt( req, res, body.html || body.content || '' );
		}
	};


	// v2 Middleware

	var wt2htmlFormats = new Set([ "pagebundle", "html" ]);
	var supportedFormats = new Set([ "pagebundle", "html", "wt" ]);

	routes.v2Middle = function( req, res, next ) {
		function errOut( err, code ) {
			// FIXME: provide more consistent error handling.
			apiUtils.sendResponse( res, {}, err, code || 404 );
		}

		var iwp = parsoidConfig.reverseMwApiMap.get(req.params.domain);
		if ( !iwp ) {
			return errOut("Invalid domain.");
		}

		res.local('iwp', iwp);
		res.local('pageName', req.params.title || '');
		res.local('oldid', req.params.revision || null);

		// "body" flag to return just the body (instead of the entire HTML doc)
		res.local('body', !!(req.query.body || req.body.body));

		var v2 = Object.assign({ format: req.params.format }, req.body);

		if (!supportedFormats.has(v2.format) ||
				(req.method === "GET" && !wt2htmlFormats.has(v2.format))) {
			return errOut("Invalid format.");
		}

		// "subst" flag to perform {{subst:}} template expansion
		res.local('subst', !!(req.query.subst || req.body.subst));
		// This is only supported for the html format
		if (res.local('subst') && v2.format !== "html") {
			return errOut("Substitution is only supported for the HTML format.", 501);
		}

		if ( req.method === "POST" ) {
			var original = v2.original || {};
			if ( original.revid ) {
				res.local('oldid', original.revid);
			}
			if ( original.title ) {
				res.local('pageName', original.title);
			}
		}

		res.local('v2', v2);
		next();
	};


	// v2 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	// GET requests
	routes.v2Get = function( req, res ) {
		wt2html( req, res );
	};

	// POST requests
	routes.v2Post = function( req, res ) {
		var v2 = res.local('v2');

		function errOut( err, code ) {
			apiUtils.sendResponse( res, res.local('env'), err, code || 404 );
		}

		if ( wt2htmlFormats.has( v2.format ) ) {
			// Accept wikitext as a string or object{body,headers}
			var wikitext = (v2.wikitext && typeof v2.wikitext !== "string") ?
				v2.wikitext.body : v2.wikitext;
			if ( typeof wikitext !== "string" ) {
				if ( !res.local('pageName') ) {
					return errOut( "No title or wikitext was provided.", 400 );
				}
				// We've been given source for this page
				if ( v2.original && v2.original.wikitext ) {
					wikitext = v2.original.wikitext.body;
				}
			}
			wt2html( req, res, wikitext );
		} else {
			// html is required for serialization
			if ( v2.html === undefined ) {
				return errOut( "No html was supplied.", 400 );
			}
			// Accept html as a string or object{body,headers}
			var html = (typeof v2.html === "string") ?
				v2.html : (v2.html.body || "");
			html2wt( req, res, html );
		}
	};


	return routes;
};
