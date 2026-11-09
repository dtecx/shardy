# Shardy popup: design system

## Direction
Native to MangaLib: reads like a panel from a MangaLib title page. Dark near-black page with raised panels, one orange accent, gray body text, text tabs with an orange underline. Light theme mirrors the site's light tokens.

## Tokens (from MangaLib theme variables)
- Page `#0a0a0a` / light `#f2f2f3`; panel `#1c1c1e` / `#ffffff`
- Ink `#ffffff`, ink-soft `#bfbfbf`, ink-muted `rgba(235,235,245,.5)` (light: `#212529`, `#5c5f66`, `#8a8a8e`)
- Edge `rgba(84,84,88,.4)`, strong `.65`; fill `rgba(118,118,128,.24)`, hover `.36`
- Field `#1a1a1a`, field edge `#3b3d45`
- Orange `#ff9100`, pressed `#f57c00`, soft `rgba(255,145,0,.16)`; done `#4baf50`; alert `#de7072`
- Card ranks: E `#65512d`, D `#b17219`, C `#9ea3a1`, B `#3aa1b1`, A `#7e57c2` (A is a guess; the site showed no A cards)

## Depth and spacing
- Surface shifts only (page → panel), hairline edges for dividers, no shadows.
- 4px grid; panel padding 12; gaps 6/8/10/12.
- Radius: 6px controls, 4px row covers, 12px panels.

## Type
System stack as on the site (`-apple-system, system-ui, "Open Sans", Roboto…`), 14px base. Hero title 16/600, facts 15/600, captions 12. Numbers use tabular-nums.

## Patterns
- Hero card: cover 52×74, eyebrow (live dot when running), 2-line title, shard glyph + `balance / need`, 4px orange track, 3-column facts grid (label above value, hairline separators), full-width 40px orange CTA with muted counter inside, one-line note or live status under it.
- Tabs: text, 38px, active = ink + 2px orange underline, count as muted superscript.
- Row: 34×48 cover, name (ink), sub 12px muted with icon, 3px track; tools are 28px ghost icon buttons at 50% opacity, full on hover/focus.
- Chips: 28px, 1px strong edge, selected = orange edge + orange-soft fill. Segmented variant = 4-column grid.
- Rank toggles: 36×30 solid rank color, off = 28% opacity.
- Signature: shard glyph in orange next to all shard numbers; rank colors used as toggles.
