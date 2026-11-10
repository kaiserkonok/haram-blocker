# Contributing

Thanks for helping. A few notes:

- **Music leaked through?** Open an issue with the video link, the time in the video, and what you heard. This is the most valuable report.
- **The one rule:** the extension must fail *closed*. On any error, the user hears silence, never the original audio. Please keep that true in every change.
- **Before a pull request,** run both tests (see the README's Development section). For audio changes, include the before and after numbers they print.
- Keep changes small and focused. Describe what you tested on (site, GPU, OS).

Good first areas: Windows/macOS installers, AMD/Apple Silicon backends, testing on more sites.
