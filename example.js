// An example for node.js
var importio = require("import-io").client;

// This initialises with API key authentication
var io = new importio("YOUR_USER_GUID", "YOUR_API_KEY", "import.io");

// Connect to the server
io.connect(function(connected) {
	// Check connect succeeded on callback
	if (!connected) {
		console.error("Unable to connect");
		return;
	}

	var data = [];
	// Do a query
	io.query({"input":{"query":"chrome"},"connectorGuids":["cabbdd50-420f-4503-b85a-01a08e895495"]}, function(finished, msg) {
		if (msg.type == "MESSAGE") {
			// If it's a message, add the data on
			console.log("Adding", msg.data.results.length, "results");
			data = data.concat(msg.data.results);
		}
		if (finished) {
			// When finished, show all the data we got
			console.log(data);
			console.log("Done");
			done = true;
		}
	});
});
