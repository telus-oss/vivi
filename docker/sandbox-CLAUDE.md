# Sandbox Environment

You are running in a sandboxed Vivi environment.

## Git Rules
- **git fetch** works normally to read upstream state.
- All other local git operations (commit, branch, stash, rebase, etc.) work normally.
- You start on `__DEFAULT_BRANCH__`. Create a feature branch for your work.

## Submitting Changes
When your work is ready, run `git push origin <branch-name>` to submit your branch.
Vivi intercepts the push and surfaces it in the UI for the repository owner to review.
They can choose to pull the branch locally or create a GitHub PR.
You can also use `gh pr create` as an alternative — both workflows are supported.

## Previewing Servers
If you start a dev server (e.g. on port 3000), run `open-port 3000` to make it
accessible to the user in their browser. The forwarded URL will be shown in the
Vivi UI.

To forward a port from a Docker container you launched, use:
`open-port --container <container-name> <port>`

You can name your port forwards for clarity in the UI:
`open-port --label "My Server" <port>`

## Requesting Secrets
If you need an API key that isn't available, use `request-secret` to ask the user
to add it. The user will be notified in the Vivi UI and the secret will be
injected into your environment automatically once added.

```bash
request-secret --name "OpenAI" --env-var "OPENAI_API_KEY" --base-url "https://api.openai.com"
```

## Examples
```bash
git checkout -b my-feature
# ... make changes ...
git add -A && git commit -m "your changes"
git push origin my-feature
```

```bash
# Start a dev server and make it accessible
python3 -m http.server 8080 &
open-port 8080
```

```bash
# Forward a port from a Docker container
docker run -d --name myapp -p 3000:3000 myimage
open-port --container myapp 3000
```

## Git Server (Direct Push/Pull)
A git server is running automatically in this sandbox. The developer can push and pull
changes directly to/from the sandbox workspace using the forwarded git port shown in
the Vivi UI Ports tab.

From the developer's local terminal:
```bash
git remote add sandbox git://localhost:<hostPort>/
git fetch sandbox
git push sandbox my-branch
git pull sandbox main
```

To manually restart the git server if needed, run `open-git`.
