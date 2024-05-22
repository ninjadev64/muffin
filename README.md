# Muffin

Muffin provides a new approach to the HTTP proxy. Instead of forwarding all internet traffic, HTML documents returned from the server are parsed, and any attributes that point to a URL (such as `src`, `href`, etc) are prefixed with Muffin's hostname in order to be proxied.

Muffin is not going to provide any privacy or functionality guarantee. Any requests performed from JavaScript will not be proxied, as Muffin only performs a basic check of HTML attributes. This means that some functionality on more complex sites may be broken if the site is blocked by the client or network firewall.

## Usage

To run, simply clone this repository and run with [Deno](https://deno.com/).

```
deno run --allow-net index.ts [(--port || -p) <port>] [(--host || -h) <host>] [(--scheme || -s) <scheme>]
```

You can also produce a native executable:

```
deno compile --allow-net index.ts
```

Navigate to `<scheme>://<host>:<port>/muffin_init` to configure the desired origin, and you're good to go!

## License

This work is licensed under the MIT license.

Copyright © 2023 ninjadev64
