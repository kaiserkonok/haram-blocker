# Contributing

Thanks for helping. A few notes:

- **Music leaked through, or a picture shown that should have been covered?** Open an issue with the link (and the time in the video, or which picture). These are the most valuable reports.
- **The one rule:** the extension must fail *closed*. On any error, the user hears silence, never the original audio, and pictures stay covered, never shown. Please keep that true in every change.
- **Before a pull request,** run the tests (see the README's Development section). For audio or image changes, include the before and after numbers they print.
- Keep changes small and focused. Describe what you tested on (site, GPU, OS).

Good first areas: Windows/macOS installers, AMD/Apple Silicon backends, testing on more sites, backgrounds from stylesheets, checking video frames.
