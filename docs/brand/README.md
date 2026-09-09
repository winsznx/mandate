# MANDATE Brand System & Usage Guidelines

MANDATE uses the **Duna** design system: a warm, near-achromatic, quiet luxury aesthetic tailored for high-assurance financial infrastructure.

## Core Assets & Locations

| Asset | File Location | Primary Purpose | Format |
|---|---|---|---|
| **Primary Logo** | `apps/web/public/brand/logo-horizontal.svg` | README header, main site footer | SVG |
| **Authority Mark** | `apps/web/public/brand/mark.svg` | Header masthead mark alongside `MANDATE` text | SVG |
| **Favicon** | `apps/web/public/brand/favicon.svg` & `favicon.png` | Web browser tab icon & fallback | SVG / PNG |
| **App / Touch Icon** | `apps/web/public/brand/app-icon-light.png` | Apple Touch Icon / mobile home screen | PNG |
| **Dark App Icon** | `apps/web/public/brand/app-icon-dark.png` | Alternative dark context app icon | PNG |
| **Open Graph Card** | `apps/web/public/brand/og-card.png` | Next.js OpenGraph / Twitter social preview (1200×630) | PNG |
| **Hero Background** | `apps/web/public/brand/hero-background.svg` | Subtle hero section background texture | SVG |
| **Authority Envelope** | `apps/web/public/brand/authority-envelope.svg` | Diagram illustrating trial-to-execution envelope | SVG |
| **Nav & Resource Icons**| `apps/web/public/brand/icons/*.svg` | Mobile navigation & footer link icons | SVG |
| **Social Avatar** | `docs/brand/social/mandate-social-avatar.png` | X / GitHub profile avatar export | PNG |
| **X Header** | `docs/brand/social/mandate-x-header.png` | X profile banner export (1500×500) | PNG |

## Duna Palette Specifications

```yaml
Aubergine Ink: "#1b0624" # Deep primary text / dark accent
Espresso:      "#160f0c" # High-contrast CTA fill / primary dark text
Onyx:          "#0d0d0d" # Absolute dark neutral
Graphite:      "#444444" # Secondary text / body text
Warm Ash:      "#766a7c" # Muted text / captions
Stone:         "#898683" # Hairline borders / neutral dividers
Bone:          "#edece7" # Subtle card borders / background hover
Mist:          "#eeeeee" # Neutral fill surface
Linen:         "#f7f7f5" # Primary container background
Paper:         "#ffffff" # Pure surface fill / card background
Terracotta:    "#8c3a24" # Accent warning / alert state
Peach:         "#f7dcc4" # Subtle warm highlight surface
Rose:          "#e6c3ca" # Muted warm accent
Warm Neutral 1:"#f2ece2" # Warm neutral fill
Warm Neutral 2:"#e9e2d7" # Warm neutral stroke
```

## Usage Rules

1. **Header Masthead**: Use `mark.svg` paired with plain live text `MANDATE` styled in Duna typography. Do not squeeze the horizontal SVG wordmark into the small masthead.
2. **Footer**: Use `logo-horizontal.svg` once, restrained and small.
3. **README**: Display `logo-horizontal.svg` centered at the top of the README.
4. **Icons**: Use navigation icons selectively (mobile drawer, footer links, developer cards). Desktop main nav remains text-first.
5. **Surfaces & Radii**: Hierarchy rules require modest radii (8–10px controls, 12–14px cards, 16px panels). Avoid pill shapes except for small status badges.
