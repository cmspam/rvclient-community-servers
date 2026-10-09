// rvbots.dll: makes the battle royale bots look for players instead of waiting to be found.
//
// The bots run the game's own AI. Its settings make them nearly blind and short-sighted:
//   - they see 5 m ahead, in a 70 degree cone (AISenseConfig_Sight of the bot controller);
//   - they look for real players only within 30 m (EQS_FindClosestCharacter, AIProfile_Default);
//   - that search drops every player they have no navigation path to yet, so on a server without
//     a navigation mesh around them they never pick a player at all.
// This DLL changes those settings in memory once the map is loaded (and again if the map is loaded
// again), before any bot spawns. Bots then walk toward players they find, climbing on the way, and
// the rest of their behavior (attacks, misses, dodges, teammates) stays as the game made it.
//
// Settings: rvbots.ini next to the executable, section [rvbots]:
//   Instances=solo-01            only these server instances (empty = all)
//   PlayerSearchRadius=150       metres
//   SightRadius=40               metres (losing sight at SightRadius + 5)
//   SightAngle=90                degrees to each side
//   KeepUnreachablePlayers=1     also pick players with no path yet (head toward them)
// Environment variables override the ini: RVBOTS_PLAYER_SEARCH_RADIUS, RVBOTS_SIGHT_RADIUS,
// RVBOTS_SIGHT_ANGLE, RVBOTS_KEEP_UNREACHABLE_PLAYERS (same units).
// RVBOTS=off in the environment turns it off. Writes rvbots.log next to the executable.
// Loaded by the Unreal Mod Unlocker through DList.ini; only runs on the game build it was made for.
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#define EXE_TIMESTAMP     0x63d40d5f
#define RVA_NAME_BLOCKS   0x571af10   // FNamePool::Blocks[]
#define RVA_OBJ_OBJECTS   0x57574c0   // GUObjectArray.ObjObjects

// UObject
#define OBJ_FLAGS   0x08
#define OBJ_INDEX   0x0c
#define OBJ_CLASS   0x10
#define OBJ_NAME    0x18
#define OBJ_OUTER   0x20
#define RF_CDO      0x10
#define IF_DEAD     ((1u << 28) | (1u << 29))   // Unreachable | PendingKill
// Reflection (UE 4.26)
#define STRUCT_SUPER        0x40
#define STRUCT_CHILDPROPS   0x50
#define FIELD_NEXT          0x20
#define FIELD_NAME          0x28
#define PROP_OFFSET         0x4c
#define PROP_EXTRA          0x78   // FStructProperty::Struct
#define BOOL_BYTEOFF        0x79
#define BOOL_FIELDMASK      0x7b

static uint64_t exe;
#define AT(rva) (exe + (rva))
static FILE* logf;
static void logmsg(const char* fmt, ...) {
    if (!logf) return;
    SYSTEMTIME t; GetSystemTime(&t);
    fprintf(logf, "[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    va_list ap; va_start(ap, fmt); vfprintf(logf, fmt, ap); va_end(ap);
    fputc('\n', logf); fflush(logf);
}

static struct { float search, sight, angle; int keep_unreachable; } cfg = { 150, 40, 90, 1 };

static int user_ptr(uint64_t p) { return p >= 0x10000 && p < 0x7fffffffffffull && !(p & 7); }

static int name_is(uint64_t fname_at, const char* want) {
    uint32_t idx = *(uint32_t*)fname_at;
    uint8_t* block = ((uint8_t**)AT(RVA_NAME_BLOCKS))[idx >> 16];
    if (!block) return 0;
    uint8_t* e = block + (idx & 0xffff) * 2;
    uint16_t hdr = *(uint16_t*)e;
    if (hdr & 1) return 0;
    size_t len = hdr >> 6;
    return len == strlen(want) && !memcmp(e + 2, want, len);
}
static int obj_named(uint64_t o, const char* want) { return user_ptr(o) && name_is(o + OBJ_NAME, want); }
static uint64_t outer(uint64_t o) { return *(uint64_t*)(o + OBJ_OUTER); }
static uint64_t class_of(uint64_t o) { return *(uint64_t*)(o + OBJ_CLASS); }

// The property called `name` in a class or struct (or its bases); 0 if there is none.
static uint64_t find_prop(uint64_t strct, const char* name) {
    for (uint64_t s = strct; user_ptr(s); s = *(uint64_t*)(s + STRUCT_SUPER))
        for (uint64_t f = *(uint64_t*)(s + STRUCT_CHILDPROPS); user_ptr(f); f = *(uint64_t*)(f + FIELD_NEXT))
            if (name_is(f + FIELD_NAME, name)) return f;
    return 0;
}
static int32_t prop_offset(uint64_t p) { return *(int32_t*)(p + PROP_OFFSET); }
static uint64_t prop_struct(uint64_t p) { return *(uint64_t*)(p + PROP_EXTRA); }

// Address of a field inside an object, following a dotted path through nested structs
// ("ProfileOptions.FlirtTargetSearchRadius"). Returns 0 when any step is missing.
static uint8_t* field(uint64_t o, const char* path, uint64_t* prop_out) {
    char buf[128]; snprintf(buf, sizeof buf, "%s", path);
    uint64_t strct = class_of(o); uint8_t* base = (uint8_t*)o; uint64_t p = 0;
    for (char* part = strtok(buf, "."); part; part = strtok(NULL, ".")) {
        if (p) strct = prop_struct(p);
        if (!user_ptr(strct) || !(p = find_prop(strct, part))) return 0;
        base += prop_offset(p);
    }
    if (prop_out) *prop_out = p;
    return base;
}

static int set_float(uint64_t o, const char* path, float v, const char* what) {
    float* f = (float*)field(o, path, NULL);
    if (!f) { logmsg("  %s: field %s not found", what, path); return 0; }
    if (*f != v) { logmsg("  %s: %s %g -> %g", what, path, *f, v); *f = v; }
    return 1;
}
static int set_bool(uint64_t o, const char* path, int v, const char* what) {
    uint64_t p; uint8_t* b = field(o, path, &p);
    if (!b) { logmsg("  %s: field %s not found", what, path); return 0; }
    uint8_t off = *(uint8_t*)(p + BOOL_BYTEOFF), mask = *(uint8_t*)(p + BOOL_FIELDMASK);
    b += off;   // the byte that holds the bit
    int cur = (*b & mask) != 0;
    if (cur != v) { logmsg("  %s: %s %s -> %s", what, path, cur ? "true" : "false", v ? "true" : "false"); *b = v ? (*b | mask) : (*b & ~mask); }
    return 1;
}
// An AIDataProvider value: the default, and the query parameter it may be bound to.
static void set_provider_float(uint64_t o, const char* path, float v, const char* what) {
    char p2[128];
    snprintf(p2, sizeof p2, "%s.DefaultValue", path); set_float(o, p2, v, what);
    snprintf(p2, sizeof p2, "%s.DataBinding", path);
    uint64_t* bind = (uint64_t*)field(o, p2, NULL);
    if (bind && user_ptr(*bind)) set_float(*bind, "FloatValue", v, what);
}
static void set_provider_bool(uint64_t o, const char* path, int v, const char* what) {
    char p2[128]; snprintf(p2, sizeof p2, "%s.DefaultValue", path); set_bool(o, p2, v, what);
}

// ---- the objects we change ----

enum { T_PROFILE, T_SIGHT, T_GENERATOR, T_PATHTEST, T_FINDTASK, NT };
static const char* TNAME[NT] = { "bot profile", "bot sight", "player search", "player search path test", "player search task" };
#define MAXPER 8
static uint64_t found[NT][MAXPER]; static int nfound[NT];

static int in_query(uint64_t o, const char* query) { return obj_named(outer(o), query); }

static int classify(uint64_t o, uint64_t cls) {
    if (obj_named(cls, "SheikAIProfile")) return obj_named(o, "AIProfile_Default") ? T_PROFILE : -1;
    if (obj_named(cls, "AISenseConfig_Sight")) {
        // the template on the bot controller class: ...SheikCharacterAIController_BP_C.AIPerception_GEN_VARIABLE.AISenseConfig_Sight_0
        uint64_t comp = outer(o);
        return user_ptr(comp) && obj_named(outer(comp), "SheikCharacterAIController_BP_C") ? T_SIGHT : -1;
    }
    if (obj_named(cls, "EnvQueryGenerator_ActorsOfClass")) return in_query(o, "EQS_FindClosestCharacter") ? T_GENERATOR : -1;
    if (obj_named(cls, "EnvQueryTest_PathfindingBatch")) return in_query(o, "EQS_FindClosestCharacter") ? T_PATHTEST : -1;
    if (obj_named(cls, "BTT_FindCharacter_C")) return T_FINDTASK;
    return -1;
}

static void scan(void) {
    memset(nfound, 0, sizeof nfound);
    uint64_t** chunks = *(uint64_t***)AT(RVA_OBJ_OBJECTS);
    int32_t num = *(int32_t*)(AT(RVA_OBJ_OBJECTS) + 0x14);
    for (int32_t i = 0; i < num; i++) {
        uint8_t* item = (uint8_t*)chunks[i >> 16] + (size_t)(i & 0xffff) * 24;
        uint64_t o = *(uint64_t*)item;
        if (!user_ptr(o) || (*(uint32_t*)(item + 8) & IF_DEAD)) continue;
        if (*(uint32_t*)(o + OBJ_FLAGS) & RF_CDO) continue;
        uint64_t cls = class_of(o);
        if (!user_ptr(cls)) continue;
        int t = classify(o, cls);
        if (t >= 0 && nfound[t] < MAXPER) found[t][nfound[t]++] = o;
    }
}

// Still the same live object in the engine's object list?
static int alive(uint64_t o) {
    if (!user_ptr(o)) return 0;
    int32_t idx = *(int32_t*)(o + OBJ_INDEX);
    int32_t num = *(int32_t*)(AT(RVA_OBJ_OBJECTS) + 0x14);
    if (idx < 0 || idx >= num) return 0;
    uint8_t* item = (uint8_t*)(*(uint64_t***)AT(RVA_OBJ_OBJECTS))[idx >> 16] + (size_t)(idx & 0xffff) * 24;
    return *(uint64_t*)item == o && !(*(uint32_t*)(item + 8) & IF_DEAD);
}
static int all_alive(void) {
    for (int t = 0; t < NT; t++) {
        if (!nfound[t]) return 0;
        for (int k = 0; k < nfound[t]; k++) if (!alive(found[t][k])) return 0;
    }
    return 1;
}

static void apply(void) {
    float search_cm = cfg.search * 100, sight_cm = cfg.sight * 100;
    for (int t = 0; t < NT; t++) for (int k = 0; k < nfound[t]; k++) {
        uint64_t o = found[t][k];
        switch (t) {
        case T_PROFILE:
            set_float(o, "ProfileOptions.FlirtTargetSearchRadius.X", search_cm, TNAME[t]);
            set_float(o, "ProfileOptions.FlirtTargetSearchRadius.Y", search_cm, TNAME[t]);
            set_float(o, "ProfileOptions.FlirtTargetSearchRadius.Z", search_cm, TNAME[t]);
            break;
        case T_SIGHT:
            set_float(o, "SightRadius", sight_cm, TNAME[t]);
            set_float(o, "LoseSightRadius", sight_cm + 500, TNAME[t]);
            set_float(o, "PeripheralVisionAngleDegrees", cfg.angle, TNAME[t]);
            break;
        case T_GENERATOR:
            set_provider_float(o, "SearchRadius", search_cm, TNAME[t]);
            break;
        case T_PATHTEST:
            if (cfg.keep_unreachable) set_provider_bool(o, "SkipUnreachable", 0, TNAME[t]);
            break;
        case T_FINDTASK: {
            // only the search for real players
            uint64_t p; uint8_t* b = field(o, "AllowRealPlayers", &p);
            if (b && (b[*(uint8_t*)(p + BOOL_BYTEOFF)] & *(uint8_t*)(p + BOOL_FIELDMASK)))
                set_float(o, "BotOnlySearchRadius", search_cm, TNAME[t]);
            break;
        }
        }
    }
}

static DWORD WINAPI run(LPVOID arg) {
    // Check every 5 s; scan the object list again whenever one of the objects is gone (the map is
    // loaded twice at startup: the engine's default load, then again when the match mode starts).
    for (int applied = 0;; Sleep(5000)) {
        int32_t num = *(int32_t*)(AT(RVA_OBJ_OBJECTS) + 0x14);
        if (num < 100000) continue;
        if (applied && all_alive()) continue;
        scan();
        int missing = 0;
        for (int t = 0; t < NT; t++) if (!nfound[t]) missing++;
        if (missing) { applied = 0; continue; }
        logmsg("settings found (%d objects in the game), applying:", num);
        apply();
        applied = 1;
    }
    return 0;
}

static int instance_excluded(const char* ini) {
    char allow[512] = "";
    GetPrivateProfileStringA("rvbots", "Instances", "", allow, sizeof allow, ini);
    if (!allow[0]) return 0;
    const char* p = strstr(GetCommandLineA(), "-RVInstance=");
    char inst[64] = "";
    if (p) { p += 12; int k = 0; while (*p && *p != ' ' && *p != '"' && k < 63) inst[k++] = *p++; inst[k] = 0; }
    for (char* tok = strtok(allow, ", "); tok; tok = strtok(NULL, ", "))
        if (inst[0] && !_stricmp(tok, inst)) return 0;
    logmsg("instance %s is not listed in rvbots.ini, doing nothing", inst[0] ? inst : "(unknown)");
    return 1;
}
// A setting: the environment variable if set, else the ini value, else the default.
static float setting(const char* ini, const char* key, const char* env, float def) {
    char v[32] = "";
    if (!GetEnvironmentVariableA(env, v, sizeof v)) GetPrivateProfileStringA("rvbots", key, "", v, sizeof v, ini);
    return v[0] ? (float)atof(v) : def;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(h);
    char dir[MAX_PATH], path[MAX_PATH + 16];
    GetModuleFileNameA(NULL, dir, MAX_PATH);
    char* s = strrchr(dir, '\\'); if (s) s[1] = 0;
    snprintf(path, sizeof path, "%srvbots.log", dir);
    logf = fopen(path, "a");

    char env[16];
    if (GetEnvironmentVariableA("RVBOTS", env, sizeof env) && !_stricmp(env, "off")) { logmsg("turned off (RVBOTS=off)"); return TRUE; }
    exe = (uint64_t)GetModuleHandleA(NULL);
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(exe + ((IMAGE_DOS_HEADER*)exe)->e_lfanew);
    if (nt->FileHeader.TimeDateStamp != EXE_TIMESTAMP) {
        logmsg("unknown game build (timestamp %08lx), doing nothing", nt->FileHeader.TimeDateStamp);
        return TRUE;
    }
    snprintf(path, sizeof path, "%srvbots.ini", dir);
    if (instance_excluded(path)) return TRUE;
    cfg.search = setting(path, "PlayerSearchRadius", "RVBOTS_PLAYER_SEARCH_RADIUS", cfg.search);
    cfg.sight = setting(path, "SightRadius", "RVBOTS_SIGHT_RADIUS", cfg.sight);
    cfg.angle = setting(path, "SightAngle", "RVBOTS_SIGHT_ANGLE", cfg.angle);
    cfg.keep_unreachable = (int)setting(path, "KeepUnreachablePlayers", "RVBOTS_KEEP_UNREACHABLE_PLAYERS", (float)cfg.keep_unreachable);
    logmsg("started: player search %g m, sight %g m / %g deg, keep unreachable players %s",
           cfg.search, cfg.sight, cfg.angle, cfg.keep_unreachable ? "yes" : "no");
    CreateThread(NULL, 0, run, NULL, 0, NULL);
    return TRUE;
}
