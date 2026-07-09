Contributing to Mana

Short version

- We do not accept external contributions (pull requests, patches, or code submissions) unless a Contributor License Agreement (CLA) is in place or you sign the Developer Certificate of Origin (DCO).
- Please do not open unsolicited pull requests — they will be closed without review.

Policy details

1. No unsolicited contributions
   - This repository is maintained by ManaAI. External pull requests will be closed unless they are part of an agreed contribution workflow.

2. Accepted contribution process
   - To propose changes, open an issue describing the change and why it is needed with examples and design notes. Maintainters will review the proposal and, if appropriate, invite you to contribute under an approved license agreement (CLA) or the DCO.
   - If invited to contribute, you will be asked to sign the project's CLA or agree to a DCO and follow any step-by-step contribution instructions provided by maintainers.

3. CLA vs DCO
   - CLA: A formal agreement that grants the project rights to use your contribution. If a CLA is required, maintainers will provide the CLA and instructions.
   - DCO: A lighter-weight attestment you sign by adding a `Signed-off-by: Your Name <you@example.com>` line to your commit message (see the Developer Certificate of Origin). Maintainers will specify which option they require for a given contribution request.

4. Artwork and images
   - Note: Artwork and images in `sprites/` are proprietary and not licensed under the project code license. Contributions that include artwork are subject to separate permissions and will generally not be accepted without explicit written agreement.

5. Third-party code and models
   - Do not submit third-party binary files, model weights, or other assets that are not explicitly allowed. Follow the instructions in THIRD_PARTY.md for obtaining and referencing external assets.

How to request contributor access

- Open an issue titled "Contribution request" with:
  - A short summary of the proposed work
  - Relevant design notes, examples, or a patch outline
  - Your preferred contribution agreement: CLA or DCO

- A maintainer will respond with next steps and, if accepted, provide the required paperwork or DCO instructions.

Contact / CLA submissions

- If you need to contact the maintainers outside of issues, or to submit a signed CLA, email: yuuzulight@gmail.com
- To sign the CLA: complete the CLA form in CLA.md, sign it, and either:
  - Email a scanned/signed copy or a PDF to yuuzulight@gmail.com, or
  - Include the signed CLA file in your PR (recommended filename conventions below) so the automated checks can detect it.

Signed CLA filename convention (recommended)

- When including a signed CLA in a PR, name the file clearly so the repository's automated checks can detect it. Recommended filename patterns (case-insensitive):
  - SIGNED_CLA_<YourName>.pdf
  - signed-cla-<yourname>.pdf
  - cla_signed_<yourname>.pdf
  - signed-agreement-<yourname>.pdf

- Place the signed CLA file at the repository root or in a top-level `cla/` directory within your PR. The automated workflow will scan changed files for names matching the patterns above and accept the PR as CLA-covered if found.

Thank you for your interest in contributing to Mana. We welcome well-scoped proposals and will respond to request issues in due course.