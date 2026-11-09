# Operator documents

Before opening public registration, publish your own privacy policy, either as a `privacy.html` here or at an address you already maintain. `terms.html` is optional. These documents are served from the account origin at `/privacy.html` and `/terms.html`; they are not inherited upstream policies. Production requires acceptance before account creation and records its timestamp.

To keep the policy in one place, set `ULTRA_PRIVACY_URL` in `deploy/.env` to its HTTPS address (for example `https://example.com/privacy-policy/`). `/privacy.html` then redirects there, the sign-up link keeps working, and no `privacy.html` file is needed. The address wins over a file if both exist. The server refuses to start if the value is not an HTTPS URL without credentials.

Configure the operator identity, contact and hosting/SMTP details for the actual deployment. This repository does not supply those statements on an operator's behalf. Keep enrollment closed until the documents and deployment have been reviewed.
