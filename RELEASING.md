# Releasing Contour

Everything needed to put Contour on GitHub and ship a release. Commands are for **PowerShell** on
Windows (they also work in Git Bash or macOS/Linux terminals).

## One-time setup

### 1. Install the tools
- **Git:** https://git-scm.com/download/win. Then set your name and email:
  ```powershell
  git config --global user.name  "Your Name"
  git config --global user.email "you@example.com"
  ```
- **GitHub CLI** (optional, but it makes the steps below one-liners): https://cli.github.com, then:
  ```powershell
  gh auth login
  ```

### 2. Check two decisions before going public
- **License.** The repository says **MIT**: anyone may use, change and even sell the code. If you
  want to keep commercial control, change `LICENSE` (and `license = "MIT"` in both `Cargo.toml` files)
  *before* the first public push, or keep the repository **private** and publish releases only.
- **Model terms.** Confirm the Mel-Band RoFormer model's terms allow your intended use (see
  `THIRD-PARTY-NOTICES.md`).

### 3. Put your GitHub username into the README
Replace `OWNER` with your GitHub username (it's in the badges and links):
```powershell
(Get-Content README.md) -replace 'OWNER', 'your-username' | Set-Content README.md
```

### 4. Create the repository and push
From the `contour` folder:
```powershell
git init -b main
git add .
git commit -m "Contour 1.0.0"
```
**With GitHub CLI** (creates the repo and pushes in one go; use `--private` if you prefer):
```powershell
gh repo create contour --public --source . --push --description "Split any song into stems, sing it, remix it, all on your own computer."
```
**Or on github.com:** click **New repository**, name it `contour`, leave it empty (no README or
license), then:
```powershell
git remote add origin https://github.com/your-username/contour.git
git push -u origin main
```

### 5. Watch the first CI run
Open the repository's **Actions** tab. The **CI** workflow runs the engine tests (Linux), checks every
interface script, and compiles the app (Windows). The first run takes longer while caches warm up.

## Shipping a release

### 6. Tag the version
```powershell
git tag v1.0.0
git push origin v1.0.0
```
The **Release** workflow builds the Windows installer (about 15-25 minutes the first time) and
attaches it to a **draft** release named *Contour v1.0.0*.

### 7. Check the draft, then publish
1. Go to **Releases** and open the draft.
2. Download `Contour_1.0.0_x64-setup.exe` and install it on a machine without your development tools
   if you can: check that the models download, a song separates, and Sing records.
3. Edit the notes if you like (paste highlights from `CHANGELOG.md`), tick **Set as the latest
   release**, and click **Publish release**.

### 8. Make the repository page shine
- **About** (the gear icon next to it): add the description and topics such as `stem-separation`,
  `karaoke`, `audio`, `music`, `tauri`, `rust`, `onnx`, `whisper`, `vocal-remover`.
- **Settings → General → Social preview:** upload `docs/screenshots/studio.jpg`.
- **Settings → General → Features:** keep **Issues** on (there's a bug-report form) and turn on
  **Discussions** if you want a community space.

## Every release after that
1. Bump the version in **four** places: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `engine/Cargo.toml` and `package.json`.
2. Add a section to `CHANGELOG.md`.
3. Commit, then tag and push:
   ```powershell
   git commit -am "Contour 1.1.0"
   git tag v1.1.0
   git push origin main v1.1.0
   ```
4. Publish the draft as in step 7.

## Later: code signing and auto-updates
- **Code signing** removes the SmartScreen warning. Buy a code-signing certificate (an OV certificate
  works; EV gains SmartScreen reputation fastest), then add the certificate details to
  `bundle.windows` in `tauri.conf.json` or sign in the workflow. See https://v2.tauri.app/distribute/sign/windows/.
- **Auto-updates:** add the Tauri updater plugin, generate a signing key pair with
  `npx tauri signer generate`, store the private key as the `TAURI_SIGNING_PRIVATE_KEY` repository
  secret, and enable `includeUpdaterJson` in `release.yml`. See https://v2.tauri.app/plugin/updater/.
