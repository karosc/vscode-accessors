# Publishing Checklist

Use this checklist before packaging or publishing the extension to the VS Code Marketplace.

## Required Metadata

- Replace `"publisher": "local"` in `package.json`
- Decide whether the package name should remain `accessor-discovery-prototype`
- Add repository metadata: `repository`, `bugs`, and `homepage`
- Add a license file and matching `license` field in `package.json`
- Add a marketplace icon and wire it through the `icon` field

## Recommended Metadata

- Keep `preview: true` until the extension is stable enough for a non-preview release
- Review the display name and description one more time before publishing
- Review keywords and categories for searchability

## Documentation

- Proofread `README.md` as if it were the marketplace landing page
- Keep `CHANGELOG.md` updated for each release
- Make sure configuration and troubleshooting steps match the current behavior

## Validation

Run the test suite:

```bash
npm test
```

Package the extension locally:

```bash
npx @vscode/vsce package
```

Publish the extension:

```bash
npx @vscode/vsce publish
```

## Nice-To-Haves Before Publishing

- Add a short demo GIF or screenshot to `README.md`
- Add an icon that matches the gallery banner
- Add CI to run `npm test` on push and pull request
- Add an explicit support policy for supported Python, xarray, and pandas versions
