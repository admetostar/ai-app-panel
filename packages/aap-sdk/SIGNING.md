# AWPK signatures (optional, local tooling)

AWPK files are ZIP containers with a `.awpk` filename and a root `manifest.json`.
The platform does not require, verify, or trust package signatures during upload.
Adding a `signature.json` file does not change validation or installation behavior.

`sign-aap.mjs` remains an optional offline utility for teams that want to record
package integrity in their own distribution workflow. Its signatures do not
establish trust unless that workflow independently verifies the signer.

```bash
# Generate a key pair (keep the private key secure and out of the repository)
node packages/aap-sdk/sign-aap.mjs keygen -o mykey.secret

# Sign and verify a local AWPK
node packages/aap-sdk/sign-aap.mjs sign dist/demo.awpk --key mykey.secret --signer your-name
node packages/aap-sdk/sign-aap.mjs verify dist/demo.awpk
```

Changing package contents invalidates an existing signature, so sign again if
your own workflow depends on this integrity check. Do not configure or rely on
platform signing keys for AWPK uploads.
