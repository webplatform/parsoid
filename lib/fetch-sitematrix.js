#!/usr/bin/env node

/**
 * Simple script to update sitematrix.json
 */

'use strict';
require('./core-upgrade.js');

var fs = require('fs');
var writeFile = Promise.promisify(fs.writeFile, false, fs);
var request = Promise.promisify(require('request'), true);
var downloadUrl = 'https://docs.webplatformstaging.org/w/sitematrix.json';
var filename = 'sitematrix.json';

request({
	url: downloadUrl,
	json: true,
}).spread(function(res, body) {
	if (res.statusCode !== 200) {
		throw 'Error fetching sitematrix! Returned ' + res.statusCode;
	}
	return writeFile(filename, JSON.stringify(body, null, '\t'));
}).then(function() {
	console.log('Success!');
}).done();
