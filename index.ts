import { parse, stringify } from "npm:himalaya";

// Configuration options
let port = 5200;
let scheme = "http";
for (let [ index, arg ] of Deno.args.entries()) {
	arg = arg.trim().toLowerCase();
	if (arg == "--port" || arg == "-p") {
		port = parseInt(Deno.args[index + 1] ?? "5200");
	} else if (arg == "--scheme" || arg == "-s") {
		scheme = Deno.args[index + 1] ?? "http";
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
`;

/**
 * Recursively iterate through the elements of an HTML document,
 * and prefix all src, srcset, href, and action attributes
 * with the hostname of the Muffin proxy.
 * @param {object} elements - The JSON representation of the HTML document.
*/
function recurse(elements: any, origin: string | null): any {
	for (const [ index, element ] of elements.entries()) {
		let attributes: { key: string, value: string }[] = [];
		for (let { key, value } of element.attributes ?? []) {
			key = key.trim().toLowerCase();
			if (value) {
				if (key == "src" || key == "href" || key == "action") {
					if (value.startsWith("http:") || value.startsWith("https:")) {
						value = `/muffin_proxy/${value}`;
					} else if (value.startsWith("//")) {
						value = `/muffin_proxy/http:${value}`;
					} else if (!value.startsWith("data:") && origin) {
						value = `/muffin_proxy/http://${origin}${value}`;
					}
				} else if (key == "srcset") {
					let sections = value.split(",");
					for (let [ index, section ] of sections.entries()) {
						section = section.trim();
						if (section.startsWith("http:") || value.startsWith("https:")) {
							sections[index] = `/muffin_proxy/${section}`;
						} else if (section.startsWith("//")) {
							sections[index] = `/muffin_proxy/http:${section}`;
						} else if (!section.startsWith("data:") && origin) {
							sections[index] = `/muffin_proxy/http://${origin}${section}`;
						}
					}
					value = sections.join(", ");
				}
			}
			attributes.push({ key, value });
		}
		elements[index].attributes = attributes;
		if (element.children) {
			elements[index].children = recurse(element.children, origin);
		}
	}
	return elements;
}

function generateErrorMessage(e: Error): string {
	return `
	<!DOCTYPE html>
	<html lang="en">
		<head>
			<style>${styles}</style>
		</head>
		<body>
			<h3> Muffins got burnt </h3>
			<p style="font-family: monospace;"> ${e.message} </p>
			<button style="width: 12rem;" onclick="window.location.replace('/muffin_init');"> Change origin </button>
		</body>
	</html>`;
}

/**
 * Handle incoming requests to the proxy.
 * @param {Request} req
 */
async function requestHandler(req: Request): Promise<Response> {
	let origin: { hostname: string, differentToConfigured: boolean };
	// Check if the user is accessing the muffin_init route or the muffin_proxy route (in order to use an origin other than the configured one).
	let url = new URL(req.url).pathname;
	if (url.startsWith("/muffin_init")) {
		let domain = decodeURIComponent(url.slice(13));
		domain = domain.trim().toLowerCase();
		if (!domain || domain == "/") {
			let body = `
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
						<input id="origin" placeholder="Domain name / IP address" onkeypress="if (event.key == 'Enter') redirect();"/>
						<button style="margin-top: 4px;" onclick="redirect();"> Go! </button>
					</body>
				</html>
			`;
			return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
		} else {
			// Make a request to the origin in order to determine if it redirects to another origin.
			let res = await fetch(`http://${domain}`);
			if (res.redirected) domain = URL.parse(res.url)?.hostname ?? domain;
			let headers = {
				"location": `/`,
				"set-cookie": `muffin_origin=${domain}; Path=/; HttpOnly; SameSite=Lax`
			};
			return new Response(null, { status: 302, headers });
		}
	} else if (url.startsWith("/muffin_proxy")) {
		let u = URL.parse(url.slice(14));
		if (!u) return new Response(generateErrorMessage(new Error("Invalid URL")), { status: 400 });
		let res = await fetch(`http://${u.hostname}`);
		if (res.redirected) u.hostname = URL.parse(res.url)?.hostname!;
		origin = { hostname: u.hostname, differentToConfigured: true };
		url = u.pathname;
	} else {
		// If accessing a path relative to the configured origin, parse the cookie header to obtain the configured origin.
		let cookies = req.headers.get("cookie") ?? "muffin_origin=";
		const { muffin_origin } = cookies.split(";").map((cookie) => cookie.split("=")).reduce((obj: any, pair) => {
			obj[decodeURIComponent(pair[0].trim())] = decodeURIComponent(pair[1].trim());
			return obj;
		}, {});
		if (!muffin_origin) {
			return new Response(null, { status: 302, headers: { "location": `${scheme}://${req.headers.get("host")}/muffin_init` } });
		}
		origin = { hostname: muffin_origin, differentToConfigured: false };
	}

	let dat;
	try {
		// Copy the headers to be forwarded to the proxied server.
		let reqHeaders: any = {};
		for (const header of desiredReqHeaders) {
			if (req.headers.has(header)) reqHeaders[header] = req.headers.get(header);
		}
		// Request the proxied server with the appropriate parameters.
		dat = await fetch(`http://${origin.hostname}${url}`, { method: req.method, headers: reqHeaders, body: [ "GET", "HEAD" ].includes(req.method) ? undefined : await req.blob() });
	} catch (e) {
		return new Response(generateErrorMessage(e), { status: 400, headers: { "content-type": "text/html" } });
	}

	// Copy the headers to be forwarded to the client.
	let resHeaders: any = {};
	for (const header of desiredResHeaders) {
		if (dat.headers.has(header)) resHeaders[header] = dat.headers.get(header);
	}

	// Prefix all src, srcset, href, and action attributes with the hostname of the Muffin proxy if the response's content type is HTML.
	// Otherwise, forward the content as-is to the client.
	const contentType = resHeaders["content-type"];
	let tbw;
	if (contentType && contentType.startsWith("text/html")) {
		try {
			tbw = stringify(recurse(parse(await dat.clone().text()), origin.differentToConfigured ? origin.hostname : null));
		} catch {
			tbw = "Muffins are undercooked (failed to parse the requested HTML document, raw contents returned)" + await dat.clone().text();
		}
	}
	if (!tbw) tbw = new Uint8Array(await dat.arrayBuffer());

	if ([ 101, 204, 205, 304 ].includes(dat.status)) {
		return new Response(null, { status: dat.status, headers: resHeaders });
	} else {
		return new Response(tbw, { status: dat.status, headers: resHeaders });
	}
}

Deno.serve({ port }, async (req) => {
	try {
		return await requestHandler(req);
	} catch (e) {
		let message = `Muffin batter was spilt while adding ${URL.parse(req.url)?.pathname}: ${e.message}`;
		console.error(message);
		return new Response(message);
	}
});
