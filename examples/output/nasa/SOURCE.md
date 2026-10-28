# Source of the NASA example

- **Title:** KSC-08-S-00035, astronaut Jim Dutton interviewed by NASA public affairs officer Allard Beutel about
  the STS-124 mission (2:25, recorded at Kennedy Space Center in 2008)
- **Page:** https://images.nasa.gov/details/ksc_053108_sts124_dutton
- **Video:** the captions were made from the 320×180 file
  (https://images-assets.nasa.gov/video/ksc_053108_sts124_dutton/ksc_053108_sts124_dutton~mobile.mp4). The demo
  streams the 800×450 file (`~orig.mp4` at the same path), whose audio lines up with it to the millisecond.
- **Captions:** made on 2026-10-28 with the [models in ../README.md](../README.md#models).

## License

NASA content is generally not copyrighted, may not be used to imply NASA's endorsement, and NASA logos and
insignia are restricted. See the
[NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).

This repository contains only the captions Overtone generated from the audio, not the video or audio itself.
NASA does not endorse this project.

## The video is not included

`*.mp4` is git-ignored. The demo streams the video from NASA: `npm run demo`, then open
http://localhost:5173/examples/demo/?clip=nasa. To run the pipeline yourself, download the 320×180 MP4 above to
`examples/media/nasa-dutton.mp4` and use the command in [../README.md](../README.md#commands).
