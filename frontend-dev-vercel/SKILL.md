---
name: frontend-dev-vercel
description: Use when designing, implementing, reviewing, or auditing frontend interfaces, web app layouts, responsive screens, forms, dashboards, navigation, interaction states, accessibility, motion, performance, or copy against Vercel's web interface guidelines.
---

# Frontend Dev Vercel

Use this skill to design or audit frontend work with a practical checklist based on Vercel's Web Interface Guidelines.

Source credit: https://vercel.com/design/guidelines

Do not fetch the source URL during normal use. The URL is attribution only; this `SKILL.md` contains the working guidance. Visit the URL only when the user explicitly asks to check the latest upstream version or compare this skill against the source.

## Workflow

When designing, apply these rules before choosing visual details. When auditing, report concrete findings with file and line references when available, grouped by severity.

1. Confirm the interface works with keyboard, screen readers, browser navigation, zoom, and mobile input.
2. Verify layout behavior across mobile, laptop, and very wide desktop widths.
3. Check loading, empty, dense, error, disabled, focused, hover, active, and destructive-action states.
4. Inspect forms for labels, validation, autocomplete, paste support, submit behavior, and password-manager compatibility.
5. Review motion for necessity, reduced-motion support, interruptibility, and compositor-friendly properties.
6. Check performance risks such as layout shift, expensive re-renders, slow mutations, oversized lists, unreserved images, and font loading.
7. Tighten copy so actions are specific, errors include recovery paths, and labels remove ambiguity.

## Interaction

- Make every flow keyboard-operable and follow WAI-ARIA authoring patterns where native HTML is not enough.
- Show visible focus for every focusable element. Prefer `:focus-visible`; use `:focus-within` for grouped controls.
- Manage modal, popover, drawer, and menu focus explicitly, including focus return.
- Match visual and hit targets. If a visual affordance is smaller than `24px`, expand the hit area to at least `24px`; use at least `44px` targets on mobile.
- Keep mobile input text at `16px` or larger so iOS does not zoom unexpectedly.
- Never disable browser zoom or paste into inputs and textareas.
- Preserve input focus and value through hydration.
- For loading buttons, keep the original label visible and add an indicator.
- Delay very fast loading indicators and keep them visible briefly once shown so the UI does not flicker.
- Persist shareable UI state in the URL, including filters, tabs, pagination, and expanded panels.
- Use optimistic updates when success is likely; on failure, show an error and roll back or offer undo.
- Confirm destructive actions or provide an undo window.
- Use links for navigation (`a` or framework link components), not buttons or divs.
- Announce asynchronous changes with polite live regions when a screen reader user needs to know.
- Keep controls forgiving: generous targets, no visual dead zones, predictable behavior, and platform-aware shortcuts.

## Layout

- Align every element intentionally to a grid, baseline, edge, or optical center.
- Adjust by a pixel when optical alignment looks better than pure geometry.
- Balance icon and text lockups by tuning stroke, weight, spacing, size, or color.
- Test responsive behavior on mobile, laptop, and ultra-wide layouts; zooming out can reveal ultra-wide issues.
- Respect safe areas for notches, rounded corners, and system UI.
- Avoid unwanted scrollbars and overflow. Test with always-visible scrollbars when possible.
- Prefer CSS layout primitives such as flex, grid, intrinsic sizing, wrapping, and alignment over JavaScript measurement.

## Content

- Prefer inline help over tooltips. Use tooltips only when space or workflow genuinely requires them.
- Match skeletons to final content dimensions to avoid layout shift.
- Keep page titles accurate to the current context.
- Avoid dead ends; every state needs a next step, retry, or recovery path.
- Design empty, sparse, dense, and error states.
- Use tabular numbers for comparable metrics.
- Never rely on color alone for status. Pair color with text, iconography, or shape.
- Give icon-only buttons accessible names and hide decorative icons from assistive tech.
- Prefer native semantics before ARIA.
- Use proper heading hierarchy and include a skip link for substantial pages.
- Make layouts resilient to short, normal, and very long user-generated content.
- Format dates, times, numbers, delimiters, and currencies for the user's locale.
- Use language preferences, not location, to choose language.
- Protect brand names, code tokens, and technical identifiers from machine translation with `translate="no"` where needed.

## Forms

- Associate every control with a real label or accessible label.
- Make label clicks focus or toggle the associated control.
- Let Enter submit simple single-input forms; in textareas, reserve Enter for line breaks and use Cmd/Ctrl+Enter for submit when supported.
- Keep submit available until submission starts. During submission, disable repeat sends, show progress, and use idempotency where the backend supports it.
- Do not block typing to enforce validation. Accept input, explain the problem, and guide correction.
- Do not pre-disable submit just because the form is incomplete; allow submission to reveal validation feedback.
- Show field errors next to fields and focus the first error after submit.
- Set useful `autocomplete`, `name`, `type`, and `inputmode` values.
- Use placeholders only as examples or patterns and make them visibly distinct from entered values.
- Warn before navigation when unsaved changes could be lost.
- Allow password managers, one-time-code autofill, and pasted codes.
- Disable spellcheck only for fields where it is harmful, such as emails, codes, and usernames.
- Trim trailing whitespace from input methods before validation when it would otherwise create confusing errors.
- Explicitly set native select text and background colors to avoid dark-mode contrast issues on Windows.

## Motion

- Honor `prefers-reduced-motion`.
- Prefer CSS animations, then Web Animations API, then JavaScript animation libraries when necessary.
- Animate `transform` and `opacity` before layout-affecting properties.
- Animate only when it clarifies cause and effect or adds intentional polish.
- Make animations interruptible by user input.
- Avoid autoplaying decorative motion; tie animation to interaction when possible.
- Set transform origins so motion appears anchored to the right source.
- Never use `transition: all`; list intended properties explicitly.
- For SVG transforms, animate wrapper groups and set `transform-box` and `transform-origin` deliberately for cross-browser behavior.

## Performance

- Test on constrained devices and browsers, including Safari and mobile low-power conditions for important UI.
- Profile with extensions disabled and with CPU or network throttling when performance matters.
- Track and minimize React re-renders in interactive surfaces.
- Batch layout reads and writes; avoid avoidable reflow and repaint loops.
- Keep mutation requests such as `POST`, `PATCH`, and `DELETE` perceptibly fast, with a target under `500ms` where the product allows.
- Prefer uncontrolled inputs or cheap controlled loops for high-frequency typing.
- Virtualize large lists or use browser containment features where appropriate.
- Preload only critical above-the-fold images and lazy-load the rest.
- Reserve image space with explicit dimensions or aspect ratios.
- Preconnect to important asset origins and preload critical fonts.
- Subset fonts and ship only needed scripts and axes.
- Move expensive work off the main thread when it blocks interaction.

## Visual Design

- Use layered shadows for believable depth and pair shadows with crisp borders when edges need clarity.
- Keep nested radii concentric; child radii should not exceed parent radii.
- On colored backgrounds, tint borders, shadows, and text toward the same hue family when that improves cohesion.
- Use chart palettes that remain distinguishable for color-blind users.
- Prefer perceptual contrast checks such as APCA when available, while still meeting project accessibility requirements.
- Make hover, active, and focus states higher contrast than rest states.
- Match browser UI to page background with theme color and `color-scheme`.
- Avoid scaling text directly in animations when it creates rendering artifacts; animate a wrapper instead.
- Watch for gradient banding and use alternatives such as images or masks when the banding is visible.

## Vercel-Style Copy

- Use active voice and action-oriented wording.
- Keep headings and button labels concise and specific.
- Use a consistent term for the same concept instead of introducing synonyms.
- Address the user directly in second person.
- Use consistent placeholders, such as `YOUR_API_TOKEN_HERE` for strings and `0123456789` for numbers.
- Use numerals for counts.
- Format currency consistently within one context; do not mix zero-decimal and two-decimal display.
- Separate numbers and units with a space, and use non-breaking spaces when the pair should stay together.
- Default to constructive language, including in errors.
- Make error messages actionable: explain what happened only as much as needed, then tell the user how to recover.
- Avoid vague button labels such as "Continue" when a specific action like "Save API Key" is available.
