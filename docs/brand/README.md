# boxery brand assets

← [Back to the docs](../README.md)

The mark is a solid cube resting on the floor of an outline cube: a VM inside a host.

| File | Use |
|---|---|
| `mark-light.svg`, `mark-dark.svg` | The mark on light or dark backgrounds. |
| `mark.svg` | The mark for inline SVG; the outline and left face take `currentColor`. |
| `lockup-light.svg`, `lockup-dark.svg` | Mark and wordmark side by side. |
| `favicon.svg` | Browser favicon; follows the viewer's light/dark setting. |
| `favicon-16.png`, `favicon-32.png` | Favicon fallbacks for browsers without SVG favicons. |
| `apple-touch-icon.png` | 180×180 home-screen icon (iOS rounds the corners). |

The favicons use a heavier cut of the mark (thicker outline, larger inner cube) so it stays legible at 16px.

## Colors

| | Hex |
|---|---|
| Ink, light backgrounds | `#2C2C2A` |
| Ink, dark backgrounds | `#F1EFE8` |
| Cube top | `#1D9E75` |
| Cube right face | `#0F6E56` |

The wordmark is JetBrains Mono Bold (SIL Open Font License), converted to outlines, with slightly tightened letter spacing.

## Favicon markup

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
