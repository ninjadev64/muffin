# Muffin

Muffin provides a new approach to the HTTP proxy. Instead of forwarding all internet traffic, HTML documents returned from the server are parsed, and any attributes that point to a URL (such as `src`, `href`, etc) are prefixed with Muffin's hostname in order to be proxied.

## Installation

To install, simply install this package from [npm](https://www.npmjs.com/package/muffin-proxy).

```
npm install -g muffin-proxy
```

## Usage

```
npx muffin-proxy [(--port || -p) <port>] [(--host || -h) <host>] [(--scheme || -s) <scheme>]
```

## License

This work is licensed under the MIT license.

Copyright © 2023 ninjadev64
