# BargazBot

BargazBot is a passion project by Devon Finney-Gaitan (RandomWolf08), focused on supporting content creators and their communities through a customizable, multipurpose Discord bot.

The project provides creator notifications, server configuration, and community management tools as part of the Bargaz software ecosystem.

## Project Scope

### Creator Notifications

BargazBot supports notifications for YouTube, Twitch, and Kick, with configurable subscriptions, destination channels, nicknames, and announcement messages.

All three platforms currently have unlimited notification capacity. Servers allocate notification capacity through `/entitlement` before configuring subscriptions through `/notification`.

### Server Configuration

BargazBot includes tools for:

- Configuring channels for notifications, logs, status messages, and project updates.
- Granting command access to specific users and roles.
- Managing notification capacity and creator subscriptions.
- Recording commands and configuration changes in server logs.

Server owners and administrators have configuration access by default.

### Shared Infrastructure

BargazBot uses shared logging, monitoring, diagnostics, and shutdown code from **[Bargaz](https://github.com/DevonFG/Bargaz)** through its npm dependency.

Bargaz manages database backup tools and host services. BargazBot retains its own database, private configuration, and Discord message delivery.

Owner-facing diagnostics provide system alerts and recovery notices through the configured Discord channels.

## Installation

The current Raspberry Pi deployment uses a parent Bargaz repository with separate BargazBot and BargazLive checkouts inside it.

```text
/home/devon/Bargaz
/home/devon/Bargaz/BargazBot
/home/devon/Bargaz/BargazLive
```

### Private Configuration

Environment files, credentials, databases, local configuration, logs, and PM2 runtime files remain outside Git.

## Related Projects and Links

- **[Bargaz](https://github.com/DevonFG/Bargaz)** — A Discord bot providing content creator notifications and community management tools.
- **[BargazLive](https://github.com/DevonFG/BargazLive)** — Website hosting and tools for livestreamers and content creators.
- **[Bargaz Website](https://bargaz.app)** — Information about Bargaz and its projects.
- **[The Wolf Den Discord Server](https://discord.gg/PvYFVshGrZ)** - Project feedback, bug reports, support, and Bargaz status.
- **[BargazBot Invite Link](https://discord.com/oauth2/authorize?client_id=1472482809095393384)** - Invite me to your Discord server!

## License

A license for Bargaz, BargazBot, and BargazLive has not yet been selected. Once selected, it will be posted at [bargaz.app/legal](https://bargaz.app/legal).

Third-party dependencies retain their respective licenses.