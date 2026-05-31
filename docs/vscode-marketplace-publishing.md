# VS Code Marketplace Publishing

The VS Code extension is published by `.github/workflows/vscode-extension.yml`.
It uses a separate release tag prefix from the browser extension workflows:

- VS Code Marketplace: `vscode-extension-v<package.json version>`
- Chrome Web Store and Firefox Add-ons: `browser-extension-v<browser-extension/manifest.json version>`

For example, publishing VS Code extension version `0.18.5` uses:

```bash
git tag vscode-extension-v0.18.5
git push origin vscode-extension-v0.18.5
```

Publishing browser extension version `0.1.2` still uses:

```bash
git tag browser-extension-v0.1.2
git push origin browser-extension-v0.1.2
```

## Marketplace Setup

The workflow expects a GitHub Actions environment named `vscode-marketplace`
with one secret:

- `VSCE_PAT`

Create that token from Azure DevOps with these values:

- Organization: `All accessible organizations`
- Scopes: `Custom defined`
- Marketplace: `Manage`

Azure DevOps requires an active Azure subscription before it can create new
organizations. If the PAT page is unavailable and Azure DevOps asks you to
create an organization first, attach an Azure subscription to the Microsoft
account, create an organization such as `wilmtang`, then return to the PAT
creation page.

Then create or verify the publisher in the Visual Studio Marketplace publisher
management page:

```text
https://marketplace.visualstudio.com/manage/publishers/
```

Use the same Microsoft account that owns the Azure DevOps token. The publisher
ID must match `publisher` in `package.json`; this repository currently uses:

```json
"publisher": "wilmtang"
```

If the publisher does not exist yet, create it from the marketplace page. The
required fields are:

- ID: `wilmtang`
- Name: `wilmtang`

After creating the publisher, verify the PAT locally if needed:

```bash
npx vsce login wilmtang
```

## GitHub Setup

In GitHub, open the repository settings and add the secret:

```text
Settings > Environments > vscode-marketplace > Environment secrets > Add secret
```

Use:

- Name: `VSCE_PAT`
- Value: the Azure DevOps Personal Access Token

The environment can optionally require manual approval before publishing. The
workflow still validates and uploads a VSIX artifact without that approval.

## Release Flow

1. Update `package.json` version and `CHANGELOG.md`.
2. Merge the release commit to `master`.
3. Push a matching VS Code extension tag:

```bash
git tag vscode-extension-v$(node -p "require('./package.json').version")
git push origin vscode-extension-v$(node -p "require('./package.json').version")
```

The publish job verifies that the tag suffix exactly matches `package.json`.
If the version and tag do not match, the job fails before publishing.

You can also run the workflow manually from GitHub Actions with `publish=true`.
Manual publishing uses the current checked-out `package.json` version and does
not require a tag.

## Manual Upload Fallback

The Visual Studio Marketplace publisher hub can upload a packaged VSIX directly
from the publisher page:

```bash
npm run build -- --out dist/vscode-leetcode-auth-sync.vsix
```

Then open:

```text
https://marketplace.visualstudio.com/manage/publishers/wilmtang
```

Choose `New extension > Visual Studio Code`, select the VSIX, and upload it.
This can publish a release without a PAT, but it does not replace the PAT for
GitHub Actions automation. Automated release tags still need `VSCE_PAT`.
