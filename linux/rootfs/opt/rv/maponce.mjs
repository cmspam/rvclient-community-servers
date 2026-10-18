// The engine starts on the island by default and StartGameMode loads the island again. Starting it
// on the small SheikEntry map with the battle royale mode removes the first load. The game writes
// Engine.ini on exit, so the section is written before every game start: once in the main Wine
// prefix for the supervisor's servers, and once in each server pair's own prefix.
//
// The same start sets the Server.dll timer in DList.ini to 5 seconds instead of 14. The file is in
// the shared game folder, so every server of the container reads the same timer.
import fs from 'node:fs';
import { dirname, join } from 'node:path';

export function applyMapOnceConfig(cmd, prefix = process.env.WINEPREFIX || '/data/wine') {
    const win64 = dirname(cmd);
    const dlist = join(win64, 'DList.ini');
    if (fs.existsSync(dlist)) {
        const text = fs.readFileSync(dlist, 'utf8');
        const slot = text.match(/^DLL(\d+)=Server\.dll\s*$/mi);
        if (slot) {
            const timer = new RegExp(`^Timer${slot[1]}=.*$`, 'mi');
            if (timer.test(text)) fs.writeFileSync(dlist, text.replace(timer, `Timer${slot[1]}=5`));
        }
    }
    const user = process.env.USER || 'root';
    const dir = join(prefix, 'drive_c', 'users', user, 'AppData', 'Local', 'Rumbleverse', 'Saved', 'Config', 'WindowsClient');
    const file = join(dir, 'Engine.ini');
    fs.mkdirSync(dir, { recursive: true });
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const section = /^\[\/Script\/EngineSettings\.GameMapsSettings\]\r?$/m.exec(text);
    if (section) {
        const start = section.index;
        const after = start + section[0].length;
        const next = text.slice(after).search(/^\[/m);
        text = text.slice(0, start) + text.slice(next < 0 ? text.length : after + next);
    }
    text = text.trimEnd() + '\n\n[/Script/EngineSettings.GameMapsSettings]\n'
        + 'GameDefaultMap=/Game/Maps/SheikEntry.SheikEntry\n'
        + 'LocalMapOptions=?game=/Game/Blueprints/Modes/BattleRoyale/SheikGameModeBR_BP.SheikGameModeBR_BP_C\n';
    fs.writeFileSync(file, text);
}
