# assets-src

Source images that are not part of the built app. Parity Technologies designed the artwork. It is
published under the repository's licence, like the code.

- `../icon.png`: 512px square, the icon a host shows in its list of products. Referenced by
  `bulletin-deploy.config.ts` and uploaded when the app is published; it is not bundled and must
  stay out of `public/`.
- `favicon-64.png`: the same artwork at 64px, inlined as a data URI in `index.html`. The
  single-file build leaves no sibling files, so the browser-tab icon has to travel inside the HTML.
  Regenerate both from the same artwork if it changes.
