# Connections

Connections are stored by SQLTools in the VS Code setting `sqltools.connections`.

## Local q example

Start q:

```sh
q -p 5000
```

Add this connection in User settings JSON:

```json
{
  "sqltools.connections": [
    {
      "name": "local kdb",
      "driver": "KDB",
      "server": "localhost",
      "port": 5000,
      "username": "",
      "password": "",
      "database": ".",
      "connectionTimeout": 30
    }
  ]
}
```

If you already have SQLTools connections, add only the connection object to the existing `sqltools.connections` array.

## Connection fields

| Field | Use |
| --- | --- |
| `name` | Display name in SQLTools. |
| `driver` | Must be `KDB`. |
| `server` | Hostname or IP address of the q process. |
| `port` | q IPC port, such as `5000`. |
| `username` | Optional q IPC username. Leave empty when not required. |
| `password` | Optional q IPC password. Leave empty when not required. |
| `database` | q namespace used by the SQLTools object explorer. Use `.` for root or values such as `.analytics`. |
| `connectionTimeout` | Connection timeout in seconds. |

Queries are sent exactly as written to the remote q process. The driver does not add a schema prefix to arbitrary query text.

## User vs workspace settings

SQLTools can save connections at User, Workspace, or Workspace Folder scope.

- User scope follows you across VS Code windows and workspaces.
- Workspace scope appears only when that workspace is open.
- Workspace Folder scope appears only for that folder in a multi-root workspace.

If a connection disappears after switching folders, check the setting scope.

## Copy example command

Run `kdb+: Copy Example Global Connection Settings` from the Command Palette to copy a User-settings example for a local q connection. Paste it into User settings JSON, then merge it with any existing `sqltools.connections` entries.

## SSH tunneling

SQLTools common connection settings handle SSH tunneling. Configure SSH in the SQLTools connection UI or JSON, then keep the kdb fields above as the final target seen through the tunnel.
