# Knowledge example

After initializing an unrelated repository with `ia init <repository> --host none --apply --yes`, copy this example's native file, document and selection into it. Commit those files before exporting.

```sh
ia kb check --json
ia kb search "Evidence stays" --json
ia kb read work-system/contract/spec/portable-knowledge --json
ia kb pack --commit FULL_COMMIT_SHA --selection selection.json --out knowledge.json --json
ia kb pack --commit FULL_COMMIT_SHA --selection selection.json --out knowledge.json --apply --yes --json
```

Local reads need no manifest. To make this selection apply to local reads too, use `.ia/knowledge.json` as its filename. Track source records, canonical documents and deliberate selectors. Package output and host storage can stay outside the repository. No `.kb` folder is needed.
