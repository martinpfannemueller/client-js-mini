/**
* import.io client library
* 
* This file contains the interface required to connect to and query import.io APIs
* 
* @author: dev@import.io
* @source: https://github.com/import-io/client-js-mini
*/
var importio = (function(inUserId, inApiKey, inHost) {

	// Create the host to connect to based on the configuration, and set up other config options
	var host = inHost || "import.io";
	
	// The user's API key credentials
	var userId = inUserId;
	var apiKey = inApiKey;

	// The user's username/password if used instead of user GUID / API key for auth
	var username = false;
	var password = false;

	// The current session, if there is one
	var currentSession = false;

	// A queue of messages ready to be sent to the server when we reconnect
	var queue = [];

	/* A session class which helps us manage our connection to the server */
	var session = (function(inIo, inHost, inUserGuid, inApiKey) {

		// Initialise the session with its configuration
		var io = inIo;
		var msgId = 1;
		var clientId = false;
		var cookies = {};
		var url = "https://query." + host + "/query/comet/";
		var messagingChannel = "/messaging";
		
		// Every time a query is issued we need somewhere to store the callbacks
		var queries = {};
		
		// The user's credentials
		var userId = inUserId;
		var apiKey = inApiKey;

		// State of our current connection to the platform
		var connected = false;
		var connecting = false;
		var disconnecting = false;
		var polling = false;

		// These variables serve to identify this client and its version to the server
		var clientName = "import.io Mini JS client";
		var clientVersion = "2.0.0";

		// If we are using node.js, then it doesn't handle cookies for
		// us automatically, so we need to setup a cookie jar to use
		var cookiejar, cj;
		if (io.isNode()) {
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
			if (io.isNode()) {
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
			var cb = io.getCB(callback);
			xhr.onreadystatechange = function() {
				if (xhr.readyState == 4) {
					var text = xhr.responseText;
					var type = "text";
					try {
						text = JSON.parse(xhr.responseText);
						type = "json";
					} catch (e) {};
					// If we are on node.js then we need to update the cookie jar
					if (io.isNode()) {
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
			if (io.isNode()) {
				var cookies = cookiejar.getCookies(new cj.CookieAccessInfo("." + host, "/", true, false));
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
			var cb = io.getCB(callback);

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
				// Don't process the response if we've disconnected in the meantime
				if (!connected && !connecting) {
					cb(false, false);
					return;
				}
				if (status == 200 && type == "json") {
					// Request succeeded - we call the callback in a timeout to allow us to return
					setTimeout(function() {
						cb(true, data);
					}, 1);
					setTimeout(function() {
						// Iterate through each of the messages that were returned
						data.map(function(msg) {

							// In this case, a browser has connected multiple clients on the same domain
							if (msg.hasOwnProperty("advice") && msg.advice.hasOwnProperty("multiple-clients") && msg.advice["multiple-clients"]) {
								console.error("Multiple clients detected, disconnecting");
								disconnect();
								return;
							}

							// If the message is not successful, i.e. an import.io server error has occurred, decide what action to take
							if (msg.hasOwnProperty("successful") && !msg.successful) {
								if (!disconnecting && connected && !connecting) {
									// If we get a 402 unknown client we need to reconnect
									if (msg.hasOwnProperty("error") && msg.error == "402::Unknown client") {
										console.error("402 received, reconnecting");
										io.reconnect();
									} else {
										console.error("Unsuccessful request: ", msg);
										return;
									}
								}
							}

							// For the message, check that the request ID matches one we sent earlier
							if (msg.channel == messagingChannel && msg.data.hasOwnProperty("requestId")) {
								var reqId = msg.data.requestId;
								if (queries.hasOwnProperty(reqId)) {
									var query = queries[reqId];
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
										delete queries[reqId];
									}

								} else {
									// We couldn't find the request ID for this message, so log an error and ignore the message
									console.error("Request ID", reqId, "does not match any known", queries);
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

		// Log in to import.io using a username and password
		var login = function(username, password, callback) {
			var cb = io.getCB(callback);
			httpRequest("POST", "https://api." + host + "/auth/login", "application/x-www-form-urlencoded", "username=" + username + "&password=" + password, function(code, type, data) {
				if (code == 200) {
					callback(true);
				} else {
					callback(false);
				}
			});
		}

		// This method uses the request helper to issue a CometD subscription request for this client on the server
		var handshake = function(callback) {
			var cb = io.getCB(callback);
			request("/meta/handshake", "handshake", {"version":"1.0","minimumVersion":"0.9","supportedConnectionTypes":["long-polling"],"advice":{"timeout":60000,"interval":0}}, function(result, data) {
				if (!result || !data.length) {
					return cb(false);
				}
				clientId = data[0].clientId;
				cb(true);
			});
		}

		// This method uses the request helper to issue a CometD subscription request for this client on the server
		var subscribe = function(channel, callback) {
			var cb = io.getCB(callback);
			request("/meta/subscribe", false, { "subscription": messagingChannel }, cb);
		}

		// Connect this client to the import.io server if not already connected
		var connect = function(callback) {
			// Don't connect again if we're already connected
			if (connected || connecting) {
				return;
			}
			connecting = true;

			var cb = io.getCB(callback);
			// Do the hanshake request to register the client on the server
			handshake(function(res) {
				if (!res) {
					connected = false;
					connecting = false;
					return cb(false);
				}

				// Register this client with a subscription to our chosen message channel
				subscribe(messagingChannel, function(result, data) {
					if (!result) {
						connected = false;
						connecting = false;
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

		// Call this method to ask the client library to disconnect from the import.io server
        // It is best practice to disconnect when you are finished with querying, so as to clean
        // up resources on both the client and server
		var disconnect = function(callback) {
			var cb = io.getCB(callback);
			// Set the flag to notify handlers that we are disconnecting, i.e. open connect calls will fail
			disconnecting = true;
			// Set the connection status flag in the library to prevent any other requests going out
			connected = false;
			// Send a "disconnected" message to all of the current queries, and then remove them
			for (var k in queries) {
				queries[k].callback(true, { "type": "DISCONNECT", "requestId": k });
				delete queries[k];
			}
			// Make the disconnect request to the server
			request("/meta/disconnect", false, false, function() {
				// Now we are disconnected we need to remove the client ID
				clientId = false;
				// We are done disconnecting so reset the flag
				disconnecting = false;
				// Call the callback to indicate we are done
				cb();
			});
		}

		// This method is called to open long-polling HTTP connections to the import.io
		// CometD server so that we can wait for any messages that the server needs to send to us
		var startPolling = function() {
			
			// Make sure we are not polling already first
			if (polling) {
				console.log("Already polling, so not polling again");
				return;
			}

			polling = true;

			var poll;
			poll = function(result, data) {
				if (connected) {
					request("/meta/connect", "connect", false, poll);
				} else {
					polling = false;
				}
			}
			poll();
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
			queries[query.requestId] = {
				"callback": callback,
				"spawned": 0,
				"started": 0,
				"completed": 0
			}
			// Issue the query to the server
			request("/service/query", false, { "data": query });
		}

		return {
			"query": query,
			"login": login,
			"connect": connect,
			"disconnect": disconnect,
			"connected": function() {
				return connected;
			},
			"testSetClientId": function(n) {
				clientId = n;
			}
		}

	});

	// This is a helper method which guarantees us a callable function irrespective of what the user provides
	var getCB = function(cb) {
		return cb || function() {};
	}

	// We need a way to detect a node.js environment throughout the library
	var isNode = function() {
		return !(typeof window != 'undefined' && window.document);
	}

	// If you want to use cookie-based authentication, this method will log you in with a username and password to get a session
	var login = function(inUsername, inPassword, callback) {
		var cb = getCB(callback);
		// Copy the configuration to the local state of the library
		username = inUsername;
		password = inPassword;

		// Callback for when we are connected to do the login
		var connectedCB = function() {
			currentSession.login(username, password, cb);
		}

		// If we don't have a session, then connect one
		if (!currentSession) {
			connect(connectedCB);
		} else {
			// Once connected, do the login
			connectedCB();
		}
	}

	// Reconnects the client to the platform by establishing a new session
	var reconnect = function(callback) {
		var cb = getCB(callback);

		console.log("Reconnecting");

		var disconnectCB = function() {
			// Reconnect using username/password if required
			if (username) {
				login(username, password, cb);
			} else {
				connect(cb);
			}
		}

		// Disconnect an old session, if there is one
		if (currentSession) {
			disconnect(disconnectCB);
		} else {
			disconnectCB();
		}
	}

	// Connect this client to the import.io server if not already connected
	var connect = function(callback) {
		var cb = getCB(callback);

		console.log("Connecting");

		// Check if there is a session already first
		if (currentSession) {
			console.error("Already have a session, using that; call disconnect() to end it");
			cb(true);
			return;
		}

		// Create a new session and connect it
		currentSession = new session(iface, host, userId, apiKey);
		currentSession.connect(function(res) {
			if (!res) {
				cb(false);
				return;
			}
			// Execute each of the queued queries
			var i = queue.length;
			while (i--) {
				query(queue[i][0], queue[i][1]);
				queue.splice(i, 1);
			}
			cb(true);
		});
	}

	// Call this method to ask the client library to disconnect from the import.io server
    // It is best practice to disconnect when you are finished with querying, so as to clean
    // up resources on both the client and server
	var disconnect = function(callback) {
		var cb = getCB(callback);

		if (currentSession) {
			console.log("Disconnecting");

			currentSession.disconnect(function() {
				currentSession = false;
				cb(true);
			});
		} else {
			console.log("Already disconnected");
			cb(false);
		}
	}

	// This method takes an import.io Query object and either queues it, or issues it to the server
	// depending on whether the session is connected
	var query = function(query, callback) {

		if (!currentSession || !currentSession.connected()) {
			console.log("Queueing query: no connected session");
			queue.push([query, callback]);
			return;
		}

		console.log("Issuing query");
		currentSession.query(query, callback);
	}

	// Return interface
	var iface = {
		"connect": connect,
		"disconnect": disconnect,
		"reconnect": reconnect,
		"login": login,
		"query": query,
		"isNode": isNode,
		"getCB": getCB,
		"testSetClientId": function(n) {
			if (currentSession) {
				currentSession.testSetClientId(n);
			}
		}
	}
	return iface;

});

// If we are running on node.js then we need to export an interface
if (new importio().isNode()) {
	exports["client"] = importio;
}
