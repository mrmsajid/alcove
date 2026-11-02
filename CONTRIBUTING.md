# Contributing

Thank you for helping. A few things make a change easy to accept.

## Set up

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
cd electron
npm install
npm start          # runs Alcove from source
npm run check      # syntax check, and that every file the app needs is packaged
```

[docs/DEVELOPER.md](docs/DEVELOPER.md) explains how the app is built (read sections 1 to 4 first), where each feature lives, how to test
it, and the traps already found. Please read section 8 before changing behaviour: tests drive a throwaway copy of the app through the
Chrome DevTools Protocol, and **never use your own Alcove profile** (set `ALCOVE_USER_DATA` to an empty folder).

## Making a change

- Keep a change to one subject. Write what was wrong, what you changed, and how you checked it in the commit message.
- Match the surrounding code: it is plain HTML, CSS and JavaScript with no framework and no bundler. Comments say *why*.
- Check the change yourself: run `npm run check`, then try it in a throwaway profile. If you add a command, setting or storage key, add it
  to the guide in the same change.
- Anything that handles web content, files or permissions needs extra care. Validate what comes in, and say in the change what it
  can and cannot do (see section 7 of the guide).
- Windows has never been run by hand by the maintainers, so notes from a Windows run are especially welcome (section 11).

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
