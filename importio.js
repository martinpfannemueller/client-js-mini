/**
* import.io client library
* 
* This file contains the interface required to connect to and query import.io APIs
* 
* @author: dev@import.io
* @source: https://github.com/import-io/client-js-mini
*/
var importio = (function(inUserId, inApiKey, inHost, inNotRandomHost, notHttps) {

	// Create the host to connect to based on the configuration, and set up other config options
	var domain = inHost || "import.io";
	var host = "http" + (notHttps ? "" : "s") + "://" + (inNotRandomHost ? "" : (Math.random()*10e19 + ".")) + "query." + domain;
	var url = host + "/query/comet/";
	var messagingChannel = "/messaging";
	var cookies = {};
	var msgId = 1;
	var clientId = false;
	// The user's credentials
	var userId = inUserId;
	var apiKey = inApiKey;

	// These variables serve to identify this client and its version to the server
	var clientName = "import.io Mini JS client"
	var clientVersion = "2.0.0"

	// State of our current connection to the platform
	var connected = false;
	var connecting = false;
	var disconnecting = false;

	// Every time a query is issued we need somewhere to store the callbacks
	var queryCache = {};

	/** Private methods */

	// This is a helper method which guarantees us a callable function irrespective of what the user provides
	var getCB = function(cb) {
		return cb || function() {};
	}

	// We need a way to detect a node.js environment throughout the library
	var isNode = function() {
		return !(typeof window != 'undefined' && window.document);
	}

	// If we are using node.js, then it doesn't handle cookies for
	// us automatically, so we need to setup a cookie jar to use
	var cookiejar, cj;
	if (isNode()) {
		cj = require("cookiejar");
		cookiejar = new cj.CookieJar();
	}

	// When not on node.js, we will use different XHR implementations depending on the browser we are in
	var XMLHttpFactories = [
		function () { return new XMLHttpRequest(); },
		function () { return new ActiveXObject("Msxml2.XMLHTTP"); },
		function () { return new ActiveXObject("Msxml3.XMLHTTP"); },
		function () { return new ActiveXObject("Microsoft.XMLHTTP"); }
	];
	// Helper method to find a compatible XHR from the selection list in a browser
	var getBrowserXHR = function() {
		for (var i=0;i<XMLHttpFactories.length;i++) {
			try {
				return XMLHttpFactories[i]();
			} catch (e) {}
		}
	}

	// Helper to get an XHR object based on our environment
	var getXHR = function() {
		if (isNode()) {
			// If we are in the node.js environment, we use the XHR node module
			var xhrRequire = require("xmlhttprequest").XMLHttpRequest;
			var obj = new xhrRequire();
			// Disable header checking for this library as we can't set cookies otherwise
			obj.setDisableHeaderCheck(true);
			return obj;
		} else {
			// For web browsers, find an XHR implementation from possible selections
			return getBrowserXHR();
		}
	}

	// Helper method that wraps up making an HTTP request
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
				// If we are on node.js then we need to update the cookie jar
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
		// If we are on node.js then we need to check the cookie jar
		if (isNode()) {
			var cookies = cookiejar.getCookies(new cj.CookieAccessInfo("." + domain, "/", true, false));
			var cookieString = [];
			cookies.map(function(cookie) {
				cookieString.push(cookie.toValueString());
			});
			xhr.setRequestHeader("Cookie", cookieString.join(";"));
			xhr.setRequestHeader("import-io-client", clientName);
			xhr.setRequestHeader("import-io-client-version", clientVersion);
		}
		xhr.send(body);
	}

	// Helper method that makes a generic request on the CometD messaging channel
	var request = function(channel, path, data, callback) {
		if (!data) {
			data = {};
		}
		var cb = getCB(callback);

		// These are CometD configuration values that are common to all requests we need to send
		data["channel"] = channel;
		data["connectionType"] = "long-polling";

		// We need to increment the message ID with each request that we send
		data["id"] = msgId;
		msgId++;

		// If we have a client ID, then we need to send that (will be provided on handshake)
		if (clientId) {
			data["clientId"] = clientId;
		}

		// Build the URL that we are going to request
		var queryUrl = url + (path ? path : "");

		// If the user has chosen API key authentication, we need to send the API key with each request
		if (apiKey) {
			queryUrl += "?_user=" + userId + "&_apikey=" + encodeURIComponent(apiKey);
		}

		httpRequest("POST", queryUrl, "application/json;charset=UTF-8", JSON.stringify([data]), function(status, type, data) {
			if (status == 200 && type == "json") {
				// Request succeeded - we call the callback in a timeout to allow us to return
				setTimeout(function() {
					cb(true, data);
				}, 1);
				setTimeout(function() {
					// Iterate through each of the messages that were returned
					data.map(function(msg) {

						// In this case, a browser has connected multiple clients on the same domain - rarely occurs when random host is enabled
						if (msg.hasOwnProperty("advice") && msg.advice.hasOwnProperty("multiple-clients") && msg.advice["multiple-clients"]) {
							console.error("Multiple clients detected, disconnecting");
							disconnect();
							return;
						}

						if (msg.hasOwnProperty("successful") && !msg.successful) {
							if (!disconnecting && connected && !connecting) {
								// If we get a 402 unknown client we need to reconnect
								if (msg.hasOwnProperty("error") && msg.error == "402::Unknown client") {
									console.error("402 received, reconnecting");
									disconnect(function() {
										// Once disconnected, reconnect
										connect();
									});
								} else {
									console.error("Unsuccessful request: ", msg);
									return;
								}
							}
						}

						// For the message, check that the request ID matches one we sent earlier
						if (msg.channel == messagingChannel && msg.data.hasOwnProperty("requestId")) {
							var reqId = msg.data.requestId;
							if (queryCache.hasOwnProperty(reqId)) {
								var query = queryCache[reqId];
								// Check the type of the message to see what we are working with
								switch (msg.data.type) {
									case "SPAWN":
										// A spawn message means that a new job is being initialised on the server
										query.spawned++;
										break;
									case "INIT":
									case "START":
										// Init and start indicate that a page of work has been started on the server
										query.started++;
										break;
									case "STOP":
										// Stop indicates that a job has finished on the server
										query.completed++;
										break;
								}

								// Update the finished state
								// The query is finished if we have started some jobs, we have finished as many as we started, and we have started as many as we have spawned
								// There is a +1 on jobsSpawned because there is an initial spawn to cover initialising all of the jobs for the query
								var finished = (query.started == query.completed) && (query.spawned + 1 == query.started) && (query.started > 0);

								// Now we have updated the status, call the callback
								setTimeout(function() {
									query.callback(finished, msg.data);
								}, 1);
								// Remove the query from the cache once it has finished
								if (finished) {
									delete queryCache[reqId];
								}

							} else {
								// We couldn't find the request ID for this message, so log an error and ignore it
								console.error("Request ID", reqId, "does not match any known", queryCache);
							}
						}
					});
				}, 1);
			} else {
				// A non-200 returned, which is an error condition
				setTimeout(function() {
					cb(false);
				}, 1);
			}
		});
	}

	// This method uses the request helper to issue a CometD subscription request for this client on the server
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

	// This method is called to open long-polling HTTP connections to the import.io
	// CometD server so that we can wait for any messages that the server needs to send to us
	var startPolling = function() {
		
		var poll;
		poll = function(result, data) {
			if (connected) {
				request("/meta/connect", "connect", false, poll);
			}
		}
		poll();
	}

	// This method uses the request helper to issue a CometD subscription request for this client on the server
	var subscribe = function(channel, callback) {
		var cb = getCB(callback);
		request("/meta/subscribe", false, { "subscription": messagingChannel }, cb);
	}

	// Connect this client to the import.io server if not already connected
	var connect = function(callback) {
		// Don't connect again if we're already connected
		if (connected || connecting) {
			return;
		}
		connecting = true;

		var cb = getCB(callback);
		// Do the hanshake request to register the client on the server
		handshake(function(res) {
			if (!res) {
				return cb(false);
			}

			// Register this client with a subscription to our chosen message channel
			subscribe(messagingChannel, function(result, data) {
				if (!result) {
					connected = false;
					return cb(false);
				}
				// Now we are subscribed, we can set the client as connected
				connected = true;
				// Start the polling to receive messages from the server
				startPolling();
				connecting = false;
				// Callback with success message
				cb(true);
			});
		});
	}

	// Disconnects the client from the server, cleaning up resources
	var disconnect = function(callback) {
		var cb = getCB(callback);
		// Send a "disconnected" message to all of the current queries, and then remove them
		for (var k in queryCache) {
			queryCache[k].callback(true, { "type": "DISCONNECT", "requestId": k });
			delete queryCache[k];
		}
		// Set the flag to notify handlers that we are disconnecting, i.e. open connect calls will fail
		disconnecting = true;
		// Set the connection status flag in the library to prevent any other requests going out
		connected = false;
		// Make the disconnect request to the server
		request("/meta/disconnect", false, false, function() {
			// Now we are disconnected we need to remove the client ID
			clientId = false;
			// If we are node.js then we need to trash the cookies too, else we will get multiple clients
			if (isNode()) {
				cookiejar = new cj.CookieJar();
			}
			// We are done disconnecting so reset the flag
			disconnecting = false;
			// Call the callback to indicate we are done
			cb();
		});
	}

	// Log in to import.io using a username and password
	var login = function(username, password, callback) {
		var cb = getCB(callback);
		httpRequest("POST", "https://api." + domain + "/auth/login", "application/x-www-form-urlencoded", "username=" + username + "&password=" + password, function(code, type, data) {
			if (code == 200) {
				callback(true);
			} else {
				callback(false);
			}
		});
	}

	// This method takes an import.io Query object and issues it to the server, calling the callback
	// whenever a relevant message is received
	var query = function(query, callback) {
		if (!connected) {
			if (connecting) {
				console.error("Wait for the connect() call to finish (use the callback function) before calling query()");
			} else {
				console.error("Call and wait for connect() before calling query()")
			}
			return false;
		}
		// Generate a random Request ID we can use to identify messages for this query
		query.requestId = "" + Math.random()*10e19;
		// Construct a new query state tracker and store it in our map of currently running queries
		queryCache[query.requestId] = {
			"callback": callback,
			"spawned": 0,
			"started": 0,
			"completed": 0
		}
		// Issue the query to the server
		request("/service/query", false, { "data": query });
	}

	// Return interface
	return {
		"connect": connect,
		"disconnect": disconnect,
		"login": login,
		"query": query,
		"isNode": isNode,
		"testSetClientId": function(n) {
			clientId = n;
		}
	}

});

// If we are running on node.js then we need to export an interface
if (new importio().isNode()) {
	exports["client"] = importio;
}
