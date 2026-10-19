/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Start Celiador ---
// Celiador: "Import Settings from Another Editor" — bring settings, keybindings,
// snippets and extensions over from Cursor or VS Code, so switching takes a
// minute. Offered once on first run when another editor is found and Celiador's
// own settings are still empty; always available from the command palette.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { parse } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OS } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IImportSource, IKeybindingRule, IMPORT_SOURCES, extensionIdsToImport, keybindingsToImport, settingsToImport, sourceExtensionsManifest, sourceUserDir } from '../common/celiadorImport.js';

const OFFERED_KEY = 'celiador.import.offered';
const FORMATTING: FormattingOptions = { tabSize: 4, insertSpaces: false, eol: '\n' };

interface IImportReport {
	settings: number;
	droppedSettings: number;
	keybindings: number;
	snippets: number;
	extensionsInstalled: number;
	extensionsUnavailable: string[];
	extensionsBlocked: number;
}

async function readText(fileService: IFileService, resource: URI): Promise<string | undefined> {
	try {
		return (await fileService.readFile(resource)).value.toString();
	} catch {
		return undefined;
	}
}

/** The editors on this machine that have a user settings folder to import from. */
async function detectSources(fileService: IFileService, userHome: URI): Promise<IImportSource[]> {
	const found: IImportSource[] = [];
	for (const source of IMPORT_SOURCES) {
		if (await fileService.exists(sourceUserDir(source, userHome, OS))) {
			found.push(source);
		}
	}
	return found;
}

/** Every service the import needs, taken from the accessor synchronously (it is invalid after an await). */
interface IImportServices {
	readonly fileService: IFileService;
	readonly environmentService: INativeEnvironmentService;
	readonly userDataProfileService: IUserDataProfileService;
	readonly galleryService: IExtensionGalleryService;
	readonly extensionManagementService: IWorkbenchExtensionManagementService;
	readonly logService: ILogService;
	readonly notificationService: INotificationService;
	readonly storageService: IStorageService;
	readonly quickInputService: IQuickInputService;
}

function importServices(accessor: ServicesAccessor): IImportServices {
	return {
		fileService: accessor.get(IFileService),
		environmentService: accessor.get(INativeEnvironmentService),
		userDataProfileService: accessor.get(IUserDataProfileService),
		galleryService: accessor.get(IExtensionGalleryService),
		extensionManagementService: accessor.get(IWorkbenchExtensionManagementService),
		logService: accessor.get(ILogService),
		notificationService: accessor.get(INotificationService),
		storageService: accessor.get(IStorageService),
		quickInputService: accessor.get(IQuickInputService),
	};
}

async function importFrom(services: IImportServices, source: IImportSource): Promise<IImportReport> {
	const { fileService, environmentService, galleryService, extensionManagementService, logService } = services;
	const profile = services.userDataProfileService.currentProfile;

	const userDir = sourceUserDir(source, environmentService.userHome, OS);
	const report: IImportReport = { settings: 0, droppedSettings: 0, keybindings: 0, snippets: 0, extensionsInstalled: 0, extensionsUnavailable: [], extensionsBlocked: 0 };

	// Settings: edit Celiador's settings.json text so its comments survive.
	const sourceSettings = parse(await readText(fileService, joinPath(userDir, 'settings.json')) ?? '{}');
	if (sourceSettings && typeof sourceSettings === 'object' && !Array.isArray(sourceSettings)) {
		let text = await readText(fileService, profile.settingsResource) ?? '{}';
		const existing = parse(text);
		const existingKeys = new Set(existing && typeof existing === 'object' ? Object.keys(existing) : []);
		const { toWrite, dropped } = settingsToImport(sourceSettings, existingKeys);
		for (const [key, value] of toWrite) {
			text = applyEdits(text, setProperty(text, [key], value, FORMATTING));
		}
		if (toWrite.length) {
			await fileService.writeFile(profile.settingsResource, VSBuffer.fromString(text));
		}
		report.settings = toWrite.length;
		report.droppedSettings = dropped.length;
	}

	// Keybindings: append rules Celiador doesn't have yet.
	const sourceKeybindings = parse(await readText(fileService, joinPath(userDir, 'keybindings.json')) ?? '[]');
	if (Array.isArray(sourceKeybindings)) {
		let text = await readText(fileService, profile.keybindingsResource) ?? '[]';
		const existing = parse(text);
		const rules = keybindingsToImport(sourceKeybindings as IKeybindingRule[], Array.isArray(existing) ? existing : []);
		if (!Array.isArray(existing)) {
			text = '[]';
		}
		for (const rule of rules) {
			text = applyEdits(text, setProperty(text, [-1], rule, FORMATTING));
		}
		if (rules.length) {
			await fileService.writeFile(profile.keybindingsResource, VSBuffer.fromString(text));
		}
		report.keybindings = rules.length;
	}

	// Snippets: copy files Celiador doesn't have; never overwrite.
	try {
		const sourceSnippets = joinPath(userDir, 'snippets');
		const stat = await fileService.resolve(sourceSnippets);
		for (const child of stat.children ?? []) {
			if (child.isFile) {
				const target = joinPath(profile.snippetsHome, child.name);
				if (!(await fileService.exists(target))) {
					await fileService.copy(child.resource, target);
					report.snippets++;
				}
			}
		}
	} catch {
		// no snippets folder — nothing to copy
	}

	// Extensions: install what Open VSX has.
	const manifest = parse(await readText(fileService, sourceExtensionsManifest(source, environmentService.userHome)) ?? '[]');
	const installed = new Set((await extensionManagementService.getInstalled()).map(e => e.identifier.id.toLowerCase()));
	const { toInstall, blocked } = extensionIdsToImport(manifest, installed);
	report.extensionsBlocked = blocked.length;
	if (toInstall.length) {
		const found = await galleryService.getExtensions(toInstall.map(id => ({ id })), CancellationToken.None);
		const foundIds = new Set(found.map(e => e.identifier.id.toLowerCase()));
		report.extensionsUnavailable = toInstall.filter(id => !foundIds.has(id));
		const results = await extensionManagementService.installGalleryExtensions(found.map(extension => ({ extension, options: {} })));
		report.extensionsInstalled = results.filter(r => !r.error).length;
		for (const r of results.filter(r => r.error)) {
			logService.warn(`[celiador-import] could not install ${r.identifier.id}: ${r.error}`);
		}
	}
	return report;
}

function summarize(source: IImportSource, report: IImportReport): string {
	const parts = [
		localize('celiadorImport.summary', "Imported from {0}: {1} settings, {2} keybindings, {3} snippet files, {4} extensions.", source.label, report.settings, report.keybindings, report.snippets, report.extensionsInstalled),
	];
	if (report.extensionsUnavailable.length) {
		parts.push(localize('celiadorImport.unavailable', "Not on Open VSX: {0}.", report.extensionsUnavailable.join(', ')));
	}
	if (report.extensionsBlocked || report.droppedSettings) {
		parts.push(localize('celiadorImport.skipped', "Skipped {0} AI or editor-specific extensions and {1} settings that Celiador replaces.", report.extensionsBlocked, report.droppedSettings));
	}
	return parts.join(' ');
}

async function runImport(services: IImportServices, source: IImportSource): Promise<void> {
	const { notificationService, storageService } = services;
	storageService.store(OFFERED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	try {
		const report = await importFrom(services, source);
		notificationService.notify({ severity: Severity.Info, message: summarize(source, report) });
	} catch (e) {
		notificationService.error(localize('celiadorImport.failed', "Import from {0} failed: {1}", source.label, e instanceof Error ? e.message : String(e)));
	}
}

class ImportFromOtherEditorAction extends Action2 {
	static readonly ID = 'celiador.importFromOtherEditor';

	constructor() {
		super({
			id: ImportFromOtherEditorAction.ID,
			title: localize2('celiadorImport.title', "Import Settings from Another Editor"),
			category: localize2('celiador.category', "Celiador"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = importServices(accessor);
		const { fileService, environmentService, quickInputService, notificationService } = services;
		const sources = await detectSources(fileService, environmentService.userHome);
		if (!sources.length) {
			notificationService.info(localize('celiadorImport.none', "No Cursor or VS Code settings were found on this machine."));
			return;
		}
		const picked = await quickInputService.pick<IQuickPickItem & { source: IImportSource }>(
			sources.map(source => ({ label: source.label, source })),
			{ placeHolder: localize('celiadorImport.pick', "Import settings, keybindings, snippets and extensions from…") }
		);
		if (picked) {
			await runImport(services, picked.source);
		}
	}
}

/** Offers the import once, on first run, when another editor is present and Celiador's settings are still empty. */
class CeliadorImportOffer extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.celiadorImportOffer';

	constructor(
		@IStorageService storageService: IStorageService,
		@IFileService fileService: IFileService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@INotificationService notificationService: INotificationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		if (storageService.getBoolean(OFFERED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		void (async () => {
			const own = parse(await readText(fileService, userDataProfileService.currentProfile.settingsResource) ?? '{}');
			if (own && typeof own === 'object' && Object.keys(own).length > 0) {
				return; // already set up — don't nag
			}
			const [first] = await detectSources(fileService, environmentService.userHome);
			if (!first) {
				return;
			}
			notificationService.prompt(
				Severity.Info,
				localize('celiadorImport.offer', "Bring your settings, keybindings and extensions over from {0}?", first.label),
				[
					{ label: localize('celiadorImport.offer.import', "Import"), run: () => commandService.executeCommand(ImportFromOtherEditorAction.ID) },
					{ label: localize('celiadorImport.offer.never', "Don't Ask Again"), run: () => storageService.store(OFFERED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE) },
				],
			);
		})();
	}
}

registerAction2(ImportFromOtherEditorAction);
registerWorkbenchContribution2(CeliadorImportOffer.ID, CeliadorImportOffer, WorkbenchPhase.Eventually);
// --- End Celiador ---
