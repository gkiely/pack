# pack

Run `pack`. Get a persistent HTTPS instance.

## Server install

On a new Linux server:

```sh
curl -fsSL https://pack.sh/server.sh | sudo sh
```

The setup script asks for your app domain, DNS provider, and DNS API key,
installs the host dependencies, configures Caddy, and starts the pack
supervisor.

## Local install

On your local machine:

```sh
curl -fsSL https://pack.sh/install.sh | sh
```

The installer asks for your deploy host and release domain, then installs the
`pack` CLI.

## Deploy

From a project directory:

```sh
pack
```

`pack` precompiles your project into a single file executable, uploads it over
SSH, and creates a persistent HTTPS instance.

## Docs

- https://pack.sh/docs/
- https://pack.sh/docs/vultr.html
- https://pack.sh/docs/digitalocean.html

## Development

```sh
bun install
bun run start
bun test
bunx tsc --noEmit
```
