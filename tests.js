/**
* import.io client library - tests
* 
* Provides test cases for the client library
* 
* @author: dev@import.io
* @source: https://github.com/import-io/client-js-mini
*/

var importio = require("./importio").client;
var assert = require("assert");

var host = process.argv[2]
var username = process.argv[3]
var password = process.argv[4]
var userguid = process.argv[5]
var apikey = process.argv[6]

// Set up a test harness for executing async tests synchronously
var asyncTestQueue = [];
var runNextTest = function() {
	if (asyncTestQueue.length) {
		var nextTest = asyncTestQueue.shift();
		nextTest(runNextTest);
	}
}
var queueTest = function(testFn) {
	asyncTestQueue.push(testFn);
}

/**
* Test 1
*
* Test that specifying incorrect username and password raises an exception
*/
queueTest(function(runNextTest) {
	var client = new importio(false, false, host);
	client.login("abc", "123", function(result) {
		assert.equal(result, false);
		console.log("Test 1: Success");
		runNextTest();
	});
});

/**
* Test 2
*
* Test that providing an incorrect user GUID raises an exception
*/
queueTest(function(runNextTest) {
	var client = new importio("00000000-0000-0000-0000-000000000000", apikey, host);
	client.connect(function(result) {
		assert.equal(result, false);
		console.log("Test 2: Success");
		runNextTest();
	});
});

/**
* Test 3
* 
* Test that providing an incorrect API key raises an exception
*/
queueTest(function(runNextTest) {
	var client = new importio(userguid, "wrongApiKey", host);
	client.connect(function(result) {
		assert.equal(result, false);
		console.log("Test 3: Success");
		runNextTest();
	});
});

/**
* Test 4
*
* Test that querying a source that doesn't exist returns an error
*/
queueTest(function(runNextTest) {
	var passed = false;
	var client = new importio(userguid, apikey, host);
	var callback = function(finished, message) {
		if (message.type == "MESSAGE" && message.data.hasOwnProperty("errorType") && message.data.errorType == "ConnectorNotFoundException") {
			passed = true;
		}
		if (finished) {
			assert.equal(passed, true);
			console.log("Test 4: Success");
			client.disconnect();
			runNextTest();
		}
	}
	client.connect(function(result) {
		client.query({ "input":{ "query": "server" }, "connectorGuids": [ "00000000-0000-0000-0000-000000000000" ] }, callback);
	});
});

/**
* Test 5
*
* Test that querying a source that returns an error is handled correctly
*/
queueTest(function(runNextTest) {
	var passed = false;
	var client = new importio(userguid, apikey, host);
	var callback = function(finished, message) {
		if (message.type == "MESSAGE" && message.data.hasOwnProperty("errorType") && message.data.errorType == "UnauthorizedException") {
			passed = true;
		}
		if (finished) {
			assert.equal(passed, true);
			console.log("Test 5: Success");
			client.disconnect();
			runNextTest();
		}
	}
	client.connect(function(result) {
		client.query({ "input":{ "query": "server" }, "connectorGuids": [ "eeba9430-bdf2-46c8-9dab-e1ca3c322339" ] }, callback);
	});
});

// Set up the expected data for the next two tests
var expectedData = [
	"Iron Man",
	"Captain America",
	"Hulk",
	"Thor",
	"Black Widow",
	"Hawkeye"
]

/**
* Test 6
*
* Tests querying a working source with user GUID and API key
*/
queueTest(function(runNextTest) {
	var data = [];
	var client = new importio(userguid, apikey, host);
	var callback = function(finished, message) {
		if (message.type == "MESSAGE") {
			message.data.results.map(function(result) {
				data.push(result["name"]);
			});
		}
		if (finished) {
			assert.deepEqual(data, expectedData);
			console.log("Test 6: Success");
			client.disconnect();
			runNextTest();
		}
	}
	client.connect(function(result) {
		client.query({ "input":{ "query": "server" }, "connectorGuids": [ "1ac5de1d-cf28-4e8a-b56f-3c42a24b1ef2" ] }, callback);
	});
});

/**
* Test 7
*
* Tests querying a working source with username and password
*/
queueTest(function(runNextTest) {
	var data = [];
	var client = new importio(false, false, host);
	var callback = function(finished, message) {
		if (message.type == "MESSAGE") {
			message.data.results.map(function(result) {
				data.push(result["name"]);
			});
		}
		if (finished) {
			assert.deepEqual(data, expectedData);
			console.log("Test 7: Success");
			client.disconnect();
			runNextTest();
		}
	}
	client.login(username, password, function() {
		client.connect(function(result) {
			client.query({ "input":{ "query": "server" }, "connectorGuids": [ "1ac5de1d-cf28-4e8a-b56f-3c42a24b1ef2" ] }, callback);
		});
	});
});

// Queue exiting the script
queueTest(function() {
	console.log("All tests completed");
	process.exit();
});

// Kick off running tests
runNextTest();