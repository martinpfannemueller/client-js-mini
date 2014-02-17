var importio = (function(inUserId, inApiKey, inHost, inNotRandomHost, notHttps) {

	var host = "http" + (notHttps ? "" : "s") + "://" + (inNotRandomHost ? "" : (Math.random()*10e17 + ".")) + (inHost || "query.import.io");
	var cookies = {};
	var msgId = 1;
	var clientId = false;
	var url = host + "/query/comet/";
	var messagingChannel = "/messaging";
	var queries = {};
	var userId = inUserId;
	var apiKey = inApiKey;

	var polling = false;
	var connected = false;

	// Cache of query callbacks
	var queryCache = {};

	/** Private methods */

	// Wrap up callbacks
	var getCB = function(cb) {
		return cb || function() {};
	}

	// Detect if node.js
	var isNode = function() {
		return !(typeof window != 'undefined' && window.document);
	}

	// If node, set up a cookie jar
	var cookiejar, cj;
	if (isNode()) {
		cj = require("cookiejar");
		cookiejar = new cj.CookieJar();
	}

	// Support for various browser XHR
	var XMLHttpFactories = [
		function () {return new XMLHttpRequest();},
		function () {return new ActiveXObject("Msxml2.XMLHTTP");},
		function () {return new ActiveXObject("Msxml3.XMLHTTP");},
		function () {return new ActiveXObject("Microsoft.XMLHTTP");}
	];
	var getBrowserXHR = function() {
		for (var i=0;i<XMLHttpFactories.length;i++) {
		try {
			return XMLHttpFactories[i]();
		}
		catch (e) {}
		}
	}

	// Helper to get an XHR object
	var getXHR = function() {
		if (isNode()) {
			// Node
			var xhrRequire = require("xmlhttprequest").XMLHttpRequest;
			var obj = new xhrRequire();
			// Disable header checking as we can't set cookies that way
			obj.setDisableHeaderCheck(true);
			return obj;
		} else {
			// Browser
			return getBrowserXHR();
		}
	}

	// Low level call to make an HTTP request
	var httpRequest = function(method, url, contentType, body, callback) {
		var xhr = getXHR();
		var cb = getCB(callback);
		xhr.onreadystatechange = function() {
			if (xhr.readyState == 4) {
				var text = xhr.responseText;
				var type = "text";
				try {
					text = JSON.parse(xhr.responseText);
					type = "json";
				} catch (e) {};
				if (isNode()) {
					var cookies = xhr.getResponseHeader("Set-Cookie");
					if (cookies) {
						cookiejar.setCookies(cookies);
					}
				}
				cb(xhr.status, type, text);
			}
		}
		xhr.open(method, url, true);
		xhr.withCredentials = true;
		if (body && method != "GET") {
			xhr.setRequestHeader("Content-Type", contentType);
		}
		if (isNode()) {
			var cookies = cookiejar.getCookies(new cj.CookieAccessInfo(".import.io"));
			var cookieString = [];
			cookies.map(function(cookie) {
				cookieString.push(cookie.toValueString());
			});
			xhr.setRequestHeader("Cookie", cookieString.join(";"));
		}
		xhr.send(body);
	}

	// Make a comet message
	var request = function(channel, path, data, callback) {
		if (!data) {
			data = {};
		}
		var cb = getCB(callback);

		data["channel"] = channel;
		data["connectionType"] = "long-polling";
		data["id"] = msgId;
		msgId++;

		if (clientId) {
			data["clientId"] = clientId;
		}

		var queryUrl = url + (path ? path : "");

		if (apiKey) {
			queryUrl += "?_user=" + userId + "&_apikey=" + encodeURIComponent(apiKey);
		}

		httpRequest("POST", queryUrl, "application/json;charset=UTF-8", JSON.stringify([data]), function(status, type, data) {
			if (status == 200 && type == "json") {
				// Request succeeded
				setTimeout(function() {
					cb(true, data);
				}, 1);
				setTimeout(function() {
					data.map(function(msg) {
						if (msg.hasOwnProperty("advice") && msg.advice.hasOwnProperty("multiple-clients") && msg.advice["multiple-clients"]) {
							console.error("Multiple clients detected, stopping polling");
							stopPolling();
						}

						if (msg.channel == messagingChannel && msg.data.hasOwnProperty("requestId")) {
							var reqId = msg.data.requestId;
							if (queryCache.hasOwnProperty(reqId)) {

								switch (msg.data.type) {
									case "SPAWN":
										queryCache[reqId].spawned++;
										break;
									case "INIT":
									case "START":
										queryCache[reqId].started++;
										break;
									case "STOP":
										queryCache[reqId].completed++;
										break;
								}

								var finished = (queryCache[reqId].started == queryCache[reqId].completed) && (queryCache[reqId].spawned + 1 == queryCache[reqId].started) && (queryCache[reqId].started > 0);

								setTimeout(function() {
									queryCache[reqId].callback(finished, msg.data);
								}, 1);
							} else {
								console.error("Request ID", reqId, "does not match any known", queryCache);
							}
						}
					});
				}, 1);
			} else {
				setTimeout(function() {
					cb(false);
				}, 1);
			}
		});
	}

	// Do a comet handshake
	var handshake = function(callback) {
		var cb = getCB(callback);
		request("/meta/handshake", "handshake", {"version":"1.0","minimumVersion":"0.9","supportedConnectionTypes":["long-polling"],"advice":{"timeout":60000,"interval":0}}, function(result, data) {
			if (!result) {
				return cb(false);
			}
			clientId = data[0].clientId;
			cb(true);
		});
	}

	var startPolling = function() {
		polling = true;
		
		var cb;
		cb = function(result, data) {
			if (polling) {
				request("/meta/connect", "connect", false, cb);
			}
		}
		cb();
	}

	var stopPolling = function() {
		polling = false;
	}

	/** Public methods */

	// Do a comet connect
	var connect = function(callback) {
		var cb = getCB(callback);
		handshake(function(res) {
			if (!res) {
				return cb(false);
			}

			request("/meta/subscribe", false, {"subscription": messagingChannel}, function(result, data) {
				if (!result) {
					connected = false;
					return cb(false);
				}
				connected = true;
				startPolling();
				cb(true);
			});
		});
	}

	// Log in using cookie auth
	var login = function(username, password, callback, host) {
		httpRequest("POST", (host ? host : "https://api.import.io") + "/auth/login", "application/x-www-form-urlencoded", "username=" + username + "&password=" + password, callback);
	}

	// Execute a query
	var query = function(query, callback) {
		if (!connected) {
			console.error("Call and wait for connect() before calling query()")
			return false;
		}
		query.requestId = Math.random()*10e17;
		queryCache[query.requestId] = {
			"callback": callback,
			"spawned": 0,
			"started": 0,
			"completed": 0
		}
		request("/service/query", false, { "data": query });
	}

	// Return interface
	return {
		"connect": connect,
		"login": login,
		"query": query,
		"isNode": isNode
	}

});

if (new importio().isNode()) {
	// Node, so export package
	exports["client"] = importio;
}
