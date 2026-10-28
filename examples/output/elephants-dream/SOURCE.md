# Source of the Elephants Dream example

- **Title:** Elephants Dream (2006), an animated short film by the Blender Foundation and the Netherlands Media
  Art Institute (Project Orange), 10:58
- **Page:** https://orange.blender.org/ (and https://studio.blender.org/projects/elephants-dream/)
- **Video:** https://download.blender.org/ED/elephantsdream-720-h264-st-aac.mov (720×405, H.264 with AAC audio in
  a QuickTime file, 152 MB). The captions were made from this file and the demo streams it, so the timing needs no
  offset.
- **Captions:** made on 2026-10-28 with the [models in ../README.md](../README.md#models).

## License

Elephants Dream is licensed under the
[Creative Commons Attribution 2.5](https://creativecommons.org/licenses/by/2.5/) license. The attribution the
project asks for when parts of the movie are reused
([orange.blender.org](https://orange.blender.org/blog/creative-commons-license-2/)):

> (c) copyright 2006, Blender Foundation / Netherlands Media Art Institute / www.elephantsdream.org

Logos and trademarks (Blender, Orange, Creative Commons) are excluded from the license. This repository contains
only the captions Overtone generated from the audio, not the video or audio itself. The Blender Foundation does
not endorse this project.

## The video is not included

`*.mov` is git-ignored. The demo streams the video from Blender: `npm run demo`, then open
http://localhost:5173/examples/demo/?clip=elephants-dream. To run the pipeline yourself, download the file above to
`examples/media/elephants-dream.mov` and use the command in [../README.md](../README.md#commands).
