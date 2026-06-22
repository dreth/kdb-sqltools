import * as vscode from 'vscode';
import { IExtension, IExtensionPlugin, IDriverExtensionApi } from '@sqltools/types';
import { ExtensionContext } from 'vscode';
import { DRIVER_ALIASES, DRIVER_NAME } from './constants';
import { selectedTextOrCurrentBlock } from './q-text';
const { publisher, name, displayName } = require('../package.json');

const SQLTOOLS_EXECUTE_QUERY = 'sqltools.executeQuery';

export async function activate(extContext: ExtensionContext): Promise<IDriverExtensionApi> {
  const sqltools = vscode.extensions.getExtension<IExtension>('mtxr.sqltools');
  if (!sqltools) {
    throw new Error('SQLTools not installed');
  }
  await sqltools.activate();

  const api = sqltools.exports;

  extContext.subscriptions.push(
    vscode.commands.registerCommand('kdb-sqltools.runFile', runQFile),
    vscode.commands.registerCommand('kdb-sqltools.runSelectionOrBlock', runQSelectionOrBlock),
    vscode.languages.registerCodeLensProvider([{ language: 'q' }, { pattern: '**/*.q' }], new QRunCodeLensProvider())
  );

  const extensionId = `${publisher}.${name}`;
  const plugin: IExtensionPlugin = {
    extensionId,
    name: `${displayName} Plugin`,
    type: 'driver',
    async register(extension) {
      // register ext part here
      extension.resourcesMap().set(`driver/${DRIVER_ALIASES[0].value}/icons`, {
        active: extContext.asAbsolutePath('icons/active.png'),
        default: extContext.asAbsolutePath('icons/default.png'),
        inactive: extContext.asAbsolutePath('icons/inactive.png'),
      });
      DRIVER_ALIASES.forEach(({ value }) => {
        extension.resourcesMap().set(`driver/${value}/extension-id`, extensionId);
        extension
          .resourcesMap()
          .set(`driver/${value}/connection-schema`, extContext.asAbsolutePath('connection.schema.json'));
        extension.resourcesMap().set(`driver/${value}/ui-schema`, extContext.asAbsolutePath('ui.schema.json'));
      });
      await extension.client.sendRequest('ls/RegisterPlugin', { path: extContext.asAbsolutePath('out/ls/plugin.js') });
    },
  };
  api.registerPlugin(plugin);
  return {
    driverName: DRIVER_NAME || displayName,
    parseBeforeSaveConnection: ({ connInfo }) => connInfo,
    parseBeforeEditConnection: ({ connInfo }) => connInfo,
    driverAliases: DRIVER_ALIASES,
  };
}

export function deactivate() {}

async function runQFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a q file before running q code.');
    return;
  }

  await executeQText(editor.document.getText());
}

async function runQSelectionOrBlock(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a q file before running q code.');
    return;
  }

  const selectionText = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection);
  const text = selectedTextOrCurrentBlock(editor.document.getText(), selectionText, editor.selection.active.line);
  await executeQText(text);
}

async function executeQText(text: string): Promise<void> {
  if (!text || text.trim().length === 0) {
    vscode.window.showWarningMessage('No q code selected to run.');
    return;
  }

  await vscode.commands.executeCommand(SQLTOOLS_EXECUTE_QUERY, text);
}

class QRunCodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: '$(play) Run q',
        command: 'kdb-sqltools.runFile',
      }),
    ];

    if (document.lineCount > 1) {
      lenses.push(new vscode.CodeLens(top, {
        title: '$(run) Run block',
        command: 'kdb-sqltools.runSelectionOrBlock',
      }));
    }

    return lenses;
  }
}
