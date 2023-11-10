#!/usr/bin/env node

import { parse, stringify } from "himalaya";
import { createServer, IncomingMessage, ServerResponse } from "http";

// Configuration options
let port = 5200;
let host = "localhost";
let scheme = "https";
for (let [ index, arg ] of process.argv.entries()) {
	arg = arg.trim().toLowerCase();
	if (arg == "--port" || arg == "-p") {
		port = parseInt(process.argv[index + 1] ?? "5200");
	} else if (arg == "--host" || arg == "-h") {
		host = process.argv[index + 1] ?? "localhost";
	} else if (arg == "--scheme" || arg == "-s") {
		scheme = process.argv[index + 1] ?? "http";
	}
}

// A list of headers received from the proxied server that should be forwarded to the client.
const desiredReqHeaders = [
	"user-agent",
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"connection",
	"cookie",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform"
];

// A list of headers received from the client that should be forwarded to the proxied server.
const desiredResHeaders = [
	"content-type"
];

// CSS to apply to Muffin configuration and error pages.
const styles = `
@import url("https://fonts.googleapis.com/css2?family=Roboto&display=swap");

* {
	text-align: center;
	margin-left: auto;
	margin-right: auto;
	font-family: "Roboto", sans-serif;
}

input, button {
	display: block;
	box-sizing: border-box;
	width: 24rem;
	padding: 4px;
	border-radius: 5px;
}

.monospace {
	font-family: monospace;
}
`;

/**
 * Recursively iterate through the elements of an HTML document,
 * and prefix all src, srcset, and href attributes
 * with the hostname of the Muffin proxy.
 * @param {object} elements - The JSON representation of the HTML document.
 * @param {string} hostname - The hostname of the Muffin proxy.
*/
function recurse(elements, hostname) {
	for (const [ index, element ] of elements.entries()) {
		let attributes = [];
		for (let { key, value } of element.attributes ?? []) {
			key = key.trim().toLowerCase();
			if (value) {
				if (key == "src" || key == "href") {
					if (value.startsWith("http")) {
						// If the URL is absolute, use the muffin_proxy route (to allow origins other than the configured one).
						value = `${scheme}://${hostname}/muffin_proxy/${value}`;
					} else {
						// Otherwise, continue using it as a path relative to the configured origin.
						value = `${scheme}://${hostname}${value.startsWith("/") ? "" : "/"}${value}`;
					}
				} else if (key == "srcset") {
					let sections = value.split(",");
					for (let [ index, section ] of sections.entries()) {
						section = section.trim();
						if (section.startsWith("http")) {
							sections[index] = `${scheme}://${hostname}/muffin_proxy/${section}`;
						} else {
							sections[index] = `${scheme}://${hostname}${section.startsWith("/") ? "" : "/"}${section}`;
						}
					}
					value = sections.join(", ");
				}
			}
			attributes.push({ key, value });
		}
		elements[index].attributes = attributes;
		if (element.children) {
			elements[index].children = recurse(element.children, hostname);
		}
	}
	return elements;
}

/**
 * Handle incoming requests to the proxy.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
async function requestListener(req, res) {
	// Wait for the request to complete, in order to obtain the request body.
	const body = await new Promise((resolve) => {
		let chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
	});
	
	// Copy the headers to be forwarded to the proxied server.
	let reqHeaders = {};
	for (const header of desiredReqHeaders) {
		if (req.headers[header]) reqHeaders[header] = req.headers[header]; 
	}

	// Check if the user is accessing the muffin_init route or the muffin_proxy route (in order to use an origin other than the configured one).
	let url = "https://example.org/";
	if (req.url.startsWith("/muffin_init")) {
		let domain = decodeURIComponent(req.url.slice(13));
		domain = domain.trim().toLowerCase();
		if (!domain || domain == "/") {
			res.writeHead(200, { "content-type": "text/html" });
			res.write(`
				<!DOCTYPE html>
				<html lang="en">
					<head>
						<style>${styles}</style>
						<script type="text/javascript">
							const redirect = () => window.location.replace("/muffin_init/" + document.getElementById("origin").value);
						</script>
					</head>
					<body>
						<h3> Oven </h3>
						<input id="origin" placeholder="Domain name / IP address" />
						<button style="margin-top: 4px;" onclick="redirect()"> Go! </button>
					</body>
				</html>
			`);
		} else {
			res.writeHead(302, {
				"location": `${scheme}://${req.headers.host}`,
				"set-cookie": `muffin_origin=${domain}; Path=/; HttpOnly; SameSite=Lax`
			});
		}
		res.end();
		return;
	} else if (req.url.startsWith("/muffin_proxy")) {
		url = decodeURIComponent(req.url.slice(14));
	} else {
		// If accessing a path relative to the configured origin, parse the cookie header to obtain the configured origin.
		if (!req.headers.cookie) req.headers.cookie = "muffin_origin=";
		const { muffin_origin } = req.headers.cookie.split(";").map((cookie) => cookie.split("=")).reduce((obj, pair) => {
			obj[decodeURIComponent(pair[0].trim())] = decodeURIComponent(pair[1].trim());
			return obj;
		}, {});
		if (!muffin_origin) {
			res.writeHead(302, { "location": `${scheme}://${req.headers.host}/muffin_init` });
			res.end();
			return;
		}
		url = `http://${muffin_origin}${req.url}`;
	}

	let dat;
	try {
		// Request the proxied server with the appropriate parameters.
		dat = await fetch(url, { method: req.method, headers: reqHeaders, body: [ "GET", "HEAD" ].includes(req.method) ? undefined : body });
	} catch (e) {
		res.writeHead(400, { "content-type": "text/html" });
		res.end(`
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<style>${styles}</style>
				</head>
				<body>
					<h3> Muffins got burnt </h3>
					<p class="monospace"> ${e.message} </p>
					<p class="monospace"> ${e.cause.code} ${e.cause.hostname ?? ""} </p>
					<button style="width: 12rem;" onclick="window.location.replace('/muffin_init');"> Change origin </button>
				</body>
			</html>
		`);
		return;
	}

	// Copy the headers to be forwarded to the client.
	let resHeaders = {};
	for (const header of desiredResHeaders) {
		if (dat.headers.get(header)) resHeaders[header] = dat.headers.get(header); 
	}
	res.writeHead(dat.status, resHeaders);

	// Prefix all src, srcset, and href attributes with the hostname of the Muffin proxy if the response's content type is HTML.
	// Otherwise, forward the content as-is to the client.
	const contentType = resHeaders["content-type"];
	let tbw;
	if (contentType && contentType.startsWith("text/html")) {
		try {
			tbw = stringify(recurse(parse(await dat.clone().text()), req.headers.host));
		} catch {
			res.write("Muffins may not have fully baked (failed to parse the requested HTML document, raw contents returned)");
		}
	}
	if (!tbw) tbw = new Uint8Array(await dat.arrayBuffer());
	res.write(tbw);

	// Conclude the returned response.
	res.end();
}

const server = createServer(async (req, res) => {
	try {
		await requestListener(req, res);
	} catch (e) {
		console.error(`Muffins exploded while flavouring with route ${req.url}`);
		console.error(e);
	}
});
server.on("error", (e) => console.error(`Muffins failed to bake:\n${e.message}`));
server.listen(port, host, () => console.log("Muffins are ready to eat!"));
