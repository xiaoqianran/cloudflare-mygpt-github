# cloudflare-mygpt-github

Cloudflare Worker gateway for two independent workflows:

1. **Custom GPT → GitHub** through a small JSON/OpenAPI control plane.
2. **Local Git → GitHub** through a native Git Smart HTTP bridge.

The GitHub credential never needs to be stored in ChatGPT or in the local Git remote URL. `GITHUB_TOKEN` stays in Cloudflare Secrets.

## Architecture

```text
                         GitHub
                           ▲
                           │ GITHUB_TOKEN
                           │ Cloudflare Secret only
                           │
                 ┌─────────┴─────────┐
                 │ Cloudflare Worker │
                 └──────┬─────┬──────┘
                        │     │
          control plane │     │ native Git data plane
                        │     │
              Bearer    │     │ HTTP Basic
             GPT_API_KEY│     │ GIT_GATEWAY_TOKEN
                        │     │
                 Custom GPT   Local Git
                              clone/fetch/pull/push
```

## Native Git mode: unrestricted after authentication

v0.4 makes the native Git side a transparent authenticated Smart HTTP proxy.

After a client authenticates with `GIT_GATEWAY_TOKEN`, the Worker does **not** impose repository/ref policy on Git traffic. GitHub itself and the permissions of `GITHUB_TOKEN` are the authority.

The gateway therefore allows whatever GitHub accepts, including:

- clone / fetch / pull
- push to `main`, `master`, or any other branch
- create/update/delete branches
- create/update/delete tags
- force push / non-fast-forward updates
- repositories outside `xiaoqianran/*` when `GITHUB_TOKEN` has permission to access them

The Worker does not parse or rewrite `git-receive-pack`; the binary request body is streamed upstream unchanged.

Authentication is still required. This is intentional: removing authentication would turn the Worker into a public write proxy backed by your GitHub credential.

### Git Smart HTTP routes

```text
GET  /git/{owner}/{repo}.git/info/refs?service=git-upload-pack
POST /git/{owner}/{repo}.git/git-upload-pack

GET  /git/{owner}/{repo}.git/info/refs?service=git-receive-pack
POST /git/{owner}/{repo}.git/git-receive-pack
```

### Clone

```bash
export GATEWAY_HOST="cloudflare-mygpt-github.<your-subdomain>.workers.dev"

git clone "https://git@${GATEWAY_HOST}/git/xiaoqianran/cloudflare-mygpt-github.git"
```

Git asks for a password. Enter the value stored as `GIT_GATEWAY_TOKEN`.

The resulting `origin` points to the Worker, so later Git network operations continue to use Cloudflare rather than contacting `github.com` directly.

### Local edit and commit

```bash
cd cloudflare-mygpt-github
# edit files
git add .
git commit -m "feat: local change"
```

`git commit` is completely local and works even without network access.

### Push

Push is enabled by default and has no Worker-side ref restriction:

```bash
git push origin main
git push --force origin main
git push origin --tags
git push origin --delete some-branch
```

Whether a push succeeds is determined by GitHub repository settings, branch protection/rulesets, and the permissions/scopes of `GITHUB_TOKEN`.

## Custom GPT control plane

The Custom GPT side remains separate from native Git and uses:

```http
Authorization: Bearer <GPT_API_KEY>
```

GPT-facing actions:

- `inspectRepository`
- `readFiles`
- `searchCode`
- `applyChanges`

Schema:

```text
https://<your-worker>/openapi.json
```

In **GPTs → Create → Configure → Actions** use **API Key → Bearer**, with the same value stored in the Worker secret `GPT_API_KEY`.

Do not put `GITHUB_TOKEN` or `GIT_GATEWAY_TOKEN` in the Custom GPT.

The GPT JSON actions still use their own higher-level policy. The unrestricted behavior described above applies specifically to native Git Smart HTTP traffic under `/git/...`.

## Deploy

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npm test
npx wrangler login
```

Configure secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GPT_API_KEY
npx wrangler secret put GIT_GATEWAY_TOKEN
```

Deploy:

```bash
npm run deploy
```

For native Git, `GITHUB_TOKEN` determines the real GitHub permission boundary. Use a GitHub token with the repository access and write permissions you actually want the gateway to have.

## Verify

```bash
export BASE_URL="https://cloudflare-mygpt-github.<your-subdomain>.workers.dev"

curl "$BASE_URL/health"
```

Expected:

```json
{"ok":true,"service":"cloudflare-mygpt-github","version":"0.4.0"}
```

Test native Git without cloning:

```bash
git ls-remote \
  "https://git@${BASE_URL#https://}/git/xiaoqianran/cloudflare-mygpt-github.git"
```

Use `GIT_GATEWAY_TOKEN` as the password.

Then test the full path:

```bash
git clone "https://git@${BASE_URL#https://}/git/xiaoqianran/cloudflare-mygpt-github.git"
cd cloudflare-mygpt-github

echo test >> gateway-test.txt
git add gateway-test.txt
git commit -m "test: native Git gateway"
git push origin main
```

## Limits

The bridge streams Git pack data instead of buffering whole repositories in Worker memory. Cloudflare request-body limits still apply to pushes because push packfiles travel from the client into the Worker. Git LFS and submodule URL rewriting are not implemented by this project.
