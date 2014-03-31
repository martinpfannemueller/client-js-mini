/**
* import.io client library - node.js example code
* 
* This file is an example for integrating with import.io using the JS client library in node.js
* 
* @author: dev@import.io
* @source: https://github.com/import-io/client-js-mini
*/

// First we need to import the client library
var importio = require("import-io").client;

// You have two choices for authenticating with the JS client: you can use your API key
// or your username and password. Username and password is quicker to get started with, but
// API key authentication will be more reliable for really large query volumes.
// If you need it, you can get YOUR_USER_GUID and YOUR_API_KEY from your account page, at
// http://import.io/data/account

// To use an API key for authentication, use the following code:
var io = new importio("6d05ddb1-f13d-43f5-a785-2e4314b79fe5", "I1YibiF/SnwQxEXe8GaytRTad1bx/vFZ/9DqmfiFDXvkuwJ/1zE/ZWk8rdfs/n0ik2q2ngD2dOARoCjv89BI4A==");

// If you wish to use username and password based authentication, first create a client:
//var io = new importio();
// Next you need to log in to import.io using your username and password, like so:
//io.login("YOUR_USERNAME", "YOUR_PASSWORD");

// Once we have started the client and authenticated, we need to connect it to the server:
io.connect(function(connected) {
	// Make sure that your code to use the library only runs after this callback has returned, 
	// as prior to this the library is still connecting and may not yet be ready to issue queries

	// Once the callback is called, we need to check whether the connection request was successful
	if (!connected) {
		console.error("Unable to connect");
		return;
	}

	// Define here a variable that we can put all our results in to when they come back from
	// the server, so we can use the data later on in the script
	var data = [];

	// Record the number of currently running queries to the server
	var runningQueries = 0;

	// In order to receive the data from the queries we issue, we need to define a callback method
	// This method will receive each message that comes back from the queries, and we can take that
	// data and store it for use in our app
	var callback = function(finished, message) {
		// Check the message we receive actually has some data in it
		if (message.type == "MESSAGE") {
			if (message.data.hasOwnProperty("errorType")) {
				// In this case, we received a message, but it was an error from the external service
				console.error("Got an error!", message.data);
			} else {
				// We got a message and it was not an error, so we can process the data
				console.log("Got data!", message.data);
				data = data.concat(message.data.results);
			}
		}
		if (finished) {
			// When the query is finished, show all the data that we received
			console.log("Done single query");
			runningQueries--;
			// If all queries are done, then log out the data we have
			if (runningQueries <= 0) {
				runningQueries = 0;
				console.log(data);
				console.log("All queries completed");
			}
		}
	}

	// Issue three queries to the same data source with different inputs
	// You can modify the inputs and connectorGuids so as to query your own sources
	// To find out more, visit the integrate page at http://import.io/data/integrate/#minijs
	
	// Also increment the number of queries we are running
	runningQueries += 3;

	io.query({"input":{ "query": "server" },"connectorGuids": [ "39df3fe4-c716-478b-9b80-bdbee43bfbde" ]}, callback);
	io.query({"input":{ "query": "ubuntu" },"connectorGuids": [ "39df3fe4-c716-478b-9b80-bdbee43bfbde" ]}, callback);
	io.query({"input":{ "query": "clocks" },"connectorGuids": [ "39df3fe4-c716-478b-9b80-bdbee43bfbde" ]}, callback);
});
