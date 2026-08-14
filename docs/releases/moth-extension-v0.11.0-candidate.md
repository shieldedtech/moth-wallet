# Moth Wallet Extension v0.11.0 release candidate

Status: ready for human review; no tag, GitHub release, npm publication, or merge has been performed.

This candidate packages the public preseed references prepared by workflow run
[`31829780286`](https://github.com/shieldedtech/moth-wallet/actions/runs/31829780286).
The workflow artifacts were reviewed and only `manifest.json` and the three
compressed public state files per network were promoted into the extension's
`public/preseed` directory. Mnemonics, cache directories, summaries, and
checksum files are not shipped.

| Network | Reference height | Preparation artifact |
| --- | ---: | --- |
| preview | 419,471 | `preseed-preview-31829780286` |
| preprod | 2,104,384 | `preseed-preprod-31829780286` |

The release workflow builds the extension from the reviewed source, verifies
the ZIP, and requires all four files for both networks. The resulting asset is
`moth-extension-0.11.0-chrome.zip`. It can be downloaded from the GitHub
release and installed locally by unzipping it and choosing **Load unpacked** in
`chrome://extensions` with Developer mode enabled.

## Promoted file checksums

These SHA-256 values are the exact files in this candidate.

```text
91d6addd709d9bbda03719a0b032769faa83ce9a6b708359592ef7ae174d58fe  packages/extension/public/preseed/preprod/dust.dat.gz
e9f6e472fd83be0b7ff16ceebf8ed0965f91c0c3000e38c9d4eb97d703d74da0  packages/extension/public/preseed/preprod/manifest.json
ae48cb37574a6f3d07610dc1b02229c3c1afeb98c13da4af38cf6006a6ca5890  packages/extension/public/preseed/preprod/shielded.dat.gz
24e60b3ac7e378998090bac7fce4f90bfa0946bd84429777892acfe045d1c7ae  packages/extension/public/preseed/preprod/unshielded.dat.gz
1aa8138c6bcac23eda2223c8c19620acf2d4654fabbddd550ebb8c77106ea765  packages/extension/public/preseed/preview/dust.dat.gz
410735c63437a272bd510029883798f89fd9d785bde859801b7d694975a72918  packages/extension/public/preseed/preview/manifest.json
298882517af320e7e83cbafe12f0814aeea224797dfc8439851d0b4a79acc624  packages/extension/public/preseed/preview/shielded.dat.gz
0b6acf51e83c2d46091cc7acaa36366e26d15c769b6c40196dc100b4cc385ce3  packages/extension/public/preseed/preview/unshielded.dat.gz
```

The exact candidate source SHA is the commit that adds this record. Governance
should record that SHA and require the release tag to point at the reviewed
merge commit, not at a mutable branch name.
