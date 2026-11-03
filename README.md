# herdr-spaces-tree

Shows herdr's Spaces sidebar as a tree: workspaces labelled `group/name` sit under a heading for their group, and each
workspace row ends with a strip of its tabs, one glyph per tab, marked by the state of that tab's agents. It draws
nothing itself. It writes per-workspace metadata tokens that your sidebar layout renders. Clicking a row focuses the
workspace (stock herdr behaviour).

```
○ scratch ▫
▾ work (3) !1 ✓1 ◐1
├ · ◐ billing-api ◐!✓▫
  ├ · ! mobile-app !○
  └ · ✓ docs-site ✓○◐?
```

It is the Spaces counterpart of [herdr-tui-agent-tree](https://github.com/harrisonhjones/herdr-tui-agent-tree), and
the two run side by side: each writes its own tokens under its own source, so neither one's `clear` touches the other.

Requires herdr >= 0.9.5 and Node (any recent version) on PATH. It is pure Node and calls herdr through
`HERDR_BIN_PATH` and `HERDR_SOCKET_PATH`. Tested on Linux, not yet Windows or macOS. Config path outside Windows:
`~/.config/herdr/config.toml`.

## Install

```sh
herdr plugin link /path/to/this/folder
```

## Required config (`~/.config/herdr/config.toml`)

The plugin cannot write client config, so add this yourself and run `herdr server reload-config`:

```toml
[ui.sidebar.spaces]
rows = [
  # Group heading, set only on the group's first workspace.
  [{ token = "$sp_group", bold = true, dim = false, fg = "#CBA6F7" }],
  # Connector, herdr's rolled-up state icon, the name without its group prefix, the tab strip.
  [{ token = "$sp_tree", dim = false, fg = "#A6ADC8" }, "state_icon", { token = "$sp_name" }, { token = "$sp_tabs", dim = false, fg = "#CDD6F4" }],
]
```

`$sp_tree` comes first on its row so that its alignment padding moves the icon and name with it. herdr joins it to
`state_icon` with ` · `. herdr's git row (`["branch", "git_status"]`) is left out because it would sit in the tree's
column.

## Glyphs

- Tab strip: one glyph per tab in tab order, showing its most urgent agent (blocked, then done, working, idle,
  unknown). `▫` is a tab with no agent.
- `◐` working, `!` blocked, `✓` done, `○` idle, `?` unknown, the same set herdr-tui-agent-tree uses.
- Group heading: `▾ <group> (<workspaces>)`, then a count for each of blocked, done and working that any workspace in
  the group is in, from herdr's rolled-up workspace state.

## Plugin config (optional)

Put a `config.json` in the plugin's config directory (`herdr plugin config-dir harrisonhjones.herdr-tui-spaces-tree`):

```json
{ "regroup": false }
```

- `regroup`: keep each group's workspaces together by reordering the Spaces list. On unless set to `false`. See Notes.

The file is read on every run, so changes show on the next event or `refresh`. An unreadable or invalid file is ignored
and logged to the plugin's stderr.

## Actions

- `herdr plugin action invoke harrisonhjones.herdr-tui-spaces-tree.refresh` forces a reconcile.
- `...clear` removes every token this plugin wrote (the Spaces rows go blank).
- `...doctor` prints the tree it would write, and whether the Spaces order would change, without changing anything.
- `...demo` relabels your real Spaces rows with fake groups, workspaces (billing-api, mobile-app, ...) and tab strips,
  so you can see the styling or take a screenshot without exposing real workspace names. Nothing real is renamed or
  reordered; it only changes the sidebar tokens. It stays on across events until you run `...demo-off`.

## Notes

- A label's first `/` splits group from name, so `a/b/c` is `b/c` in group `a`. A label with nothing on one side of
  the slash is ungrouped. Renaming a workspace is how it moves between groups.
- A plugin can't group Spaces rows, only set their text, so with `regroup` on each run reorders the list: ungrouped
  workspaces first, then each group where its longest unbroken run already sits. A workspace renamed into a group, or
  dragged out of one, joins the end of its group; dragging within a group sticks. It uses one
  `workspace.move_block` socket request and writes nothing when the order is already grouped.
- Every event (pane, tab and workspace changes, agent status changes) runs one idempotent reconcile and writes only
  changed workspaces. Runs are serialized by a lock under `HERDR_PLUGIN_STATE_DIR`.
- Alignment: herdr indents an entry's first row by 1 and later rows by 3, and trims leading whitespace from token
  values. Grouped workspaces without a heading row are padded with `SPACES_TREE_PAD` (default 2) U+2800 characters so
  connectors line up. Override the character with `SPACES_TREE_PAD_CHAR`.
- Without the plugin (or after `clear`) the Spaces rows show only herdr's state icon, because the layout's text comes
  from plugin tokens.
- Tests: `node --test`.
- To uninstall cleanly: run `clear`, `herdr plugin unlink harrisonhjones.herdr-tui-spaces-tree`, and restore your
  config.

## License

MIT. See [LICENSE](LICENSE).
