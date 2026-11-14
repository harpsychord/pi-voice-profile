# pi-voice-profile

A pi extension that injects a voice profile document into the
system prompt. The document defines a conversational register
for assistant replies: eight rules covering the shape,
texture, and length of prose in casual conversation, opinion,
banter, and discussion.

## What it does

- Loads `references/voice-profile.md` at session start and
  injects it into the system prompt on every model request.
- Survives context compaction by construction; the document
  is resident in the prompt, not the transcript.
- Prints a load notification at session start.
- If the document is missing or unreadable, a loud gap marker
  goes into the prompt instead of a silent fallback.

## The rules, in one line each

- V1. Talk, don't write. No announcements, scaffolds,
  verdict-first openings, introducing colons, em-dashes,
  value previews, or grading.
- V2. One point per turn; a second thought is an aside.
- V3. Length varies; one line is a complete answer.
- V4. Take a position; hedge once, only when you have to.
- V5. Don't end with a question or an offer.
- V6. Correct yourself the way speech does; no set phrase.
- V7. No closing summary; the last point made is the ending.
- V8. No commentary on the delivery itself.

The document is self-standing. It applies on its own and
yields to any higher-priority instructions loaded alongside
it, including mandated reply headers, which are exempt from
the punctuation rules.

## Install

Install as a pi package from git:

    pi install git:github.com/harpsychord/pi-voice-profile@v2.1.1

or from a local checkout:

    pi install ./pi-voice-profile

npm installation is planned but not available yet, see the
repo issue tagged "not implemented".

`pi list` shows installed packages, `pi remove` removes one, and
`pi update --extensions` reconciles. The package uses the
conventional layout, so extensions/index.ts is discovered
automatically and the voice document sits beside it in
extensions/references/.

## License

GPL-3.0, see LICENSE.

Maintainer: Harper Sanford.
