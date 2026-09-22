# Report assets

`mark.svg` is the roundel from `craft/templates/_includes/page/logo.twig`, on its own so the
PDF's running footer can carry it.

**WHY A COPY AND NOT THE INCLUDE.** Chromium's header and footer templates are rendered as
their own little documents: they inherit no stylesheet from the page, and an image in them
has to arrive as a data URI because the template is not resolved against the page's origin.
So the footer cannot reach the site's markup, its sprite, or anything under `/dist`, and the
mark has to be a file this module can read off disk and inline.

**THE WHITE DISC IS GONE ON PURPOSE.** The roundel is a navy mark on a white circle; on white
paper the circle is invisible, so only the navy path is kept. If the mark is ever redrawn,
copy the `roundel-front` path out of that include again rather than exporting something new,
or the footer and the site's header will slowly stop being the same logo.
