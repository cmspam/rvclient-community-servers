// rvslim.dll: frees memory a Rumbleverse server never uses.
//
// The community server is the game client started with -nullrhi -nosound. It still loads everything
// a player's PC needs for graphics and sound, and keeps it, because the step that would normally
// hand that data to the graphics card (and then drop the copy) never runs without a renderer.
// While the map loads, this DLL releases:
//   - static mesh vertex and index buffers, through the engine's own Discard() (what a normal client
//     does right after uploading a mesh to the GPU); LOD 0 positions and indices are kept, because
//     collision is built from them
//   - static mesh distance fields (GPU lighting data)
//   - texture pixel data and compressed sound data
// Collision, animation and gameplay data are not touched.
//
// It also moves the 433 MB static data block of the backend SDK (Cozmo.dll) out of memory: to swap
// on Linux, to the page file on Windows. It is filled once at start and not used afterwards; the
// contents stay intact and come back if anything reads them.
//
// Loaded by the Unreal Mod Unlocker through DList.ini. It only runs on the game build it was made for
// (checked through the executable's build timestamp); on any other build it does nothing.
// Writes a short report to rvslim.log next to the executable.
// RVSLIM=off in the environment turns it off. rvslim.ini next to the executable can limit it to
// some server instances:
//   [rvslim]
//   Instances=solo-01,duos-01
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

// RumbleverseClient-Win64-Shipping.exe, build timestamp 0x63d40d5f.
// Locations are offsets from the start of the executable in memory.
#define EXE_TIMESTAMP     0x63d40d5f
#define RVA_NAME_BLOCKS   0x571af10   // FNamePool::Blocks[]
#define RVA_OBJ_OBJECTS   0x57574c0   // GUObjectArray.ObjObjects (chunk table; NumElements at +0x14)
#define RVA_FMEMORY_FREE  0x15676c0   // FMemory::Free(void*)
#define RVA_RA_GETDATA    0x0d6f340   // FResourceArrayInterface::GetResourceData (shared by all buffers)
#define RVA_RA_ALLOWCPU   0x0d6b5a0   // FResourceArrayInterface::GetAllowCPUAccess (shared by all buffers)
#define RVA_DF_VTABLE     0x4aa2f90   // FDistanceFieldVolumeData
#define RVA_RDATA_LO      0x4008000
#define RVA_RDATA_HI      0x533d000

// UObject layout
#define OBJ_FLAGS         0x08
#define OBJ_CLASS         0x10
#define OBJ_NAME          0x18
// Object flags meaning "default object", "not fully loaded" or "being destroyed"
#define RF_SKIP           (0x10 | 0x200 | 0x400 | 0x1000 | 0x2000 | 0x8000 | 0x10000)
// Object list flags: AsyncLoading | Unreachable | PendingKill
#define IF_SKIP           ((1u << 27) | (1u << 28) | (1u << 29))

// UStaticMesh -> FStaticMeshRenderData -> LOD resources
#define SM_RENDERDATA     0x70
static const int LOD_BUFFERS_INLINE[] = { 0x198, 0x1d8, 0x218 };       // index buffers
static const int LOD_BUFFERS_HELD[]   = { 0xb8, 0xc8, 0x120, 0x158 };  // tangents, UVs, positions, colors
#define LOD0_INDEX        0x198
#define LOD0_POSITIONS    0x120
#define LOD_DISTFIELD     0x38
// Textures: platform data -> mips (array of pointers at +0x18); bulk data record at mip + 0x10
#define TEX2D_PLATFORMDATA   0x190
#define TEXCUBE_PLATFORMDATA 0x178
// SoundWave: compressed formats, array of {name, bulk data record pointer} at +0x340
#define SND_FORMATS       0x340
// Bulk data record: +0x8 data, +0x10 size, +0x20 flags
#define BULK_ALWAYS_DISCARD 0x10000000u
#define BULK_MEMORY_MAPPED  0x40000000u

typedef void (*FreeFn)(void*);
typedef void (*DiscardFn)(void*);
typedef uint32_t (*SizeFn)(void*);

static uint64_t exe;   // where the executable is loaded
#define AT(rva) (exe + (rva))

static FILE* logf;
static void logmsg(const char* fmt, ...) {
    if (!logf) return;
    SYSTEMTIME t; GetSystemTime(&t);
    fprintf(logf, "[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    va_list ap; va_start(ap, fmt); vfprintf(logf, fmt, ap); va_end(ap);
    fputc('\n', logf); fflush(logf);
}

static int user_ptr(uint64_t p) { return p >= 0x10000 && p < 0x7fffffffffffull && !(p & 7); }

// Compares an engine name (by index) with an ASCII string.
static int name_is(uint32_t idx, const char* want) {
    uint8_t* block = ((uint8_t**)AT(RVA_NAME_BLOCKS))[idx >> 16];
    if (!block) return 0;
    uint8_t* e = block + (idx & 0xffff) * 2;
    uint16_t hdr = *(uint16_t*)e;
    if (hdr & 1) return 0;                               // wide name
    size_t len = hdr >> 6;
    return len == strlen(want) && !memcmp(e + 2, want, len);
}

enum { K_OTHER, K_MESH, K_TEX2D, K_TEXCUBE, K_SOUND };
#define NCLS 4096
static uint64_t cls_ptr[NCLS]; static uint8_t cls_kind[NCLS];
static int kind_of(uint64_t cls) {
    uint32_t h = (uint32_t)((cls >> 4) * 2654435761u) & (NCLS - 1);
    for (int n = 0; n < NCLS; n++, h = (h + 1) & (NCLS - 1)) {
        if (cls_ptr[h] == cls) return cls_kind[h];
        if (!cls_ptr[h]) {
            uint32_t idx = *(uint32_t*)(cls + OBJ_NAME);
            int k = name_is(idx, "StaticMesh") ? K_MESH
                  : name_is(idx, "Texture2D") ? K_TEX2D
                  : (name_is(idx, "TextureCube") || name_is(idx, "VolumeTexture")) ? K_TEXCUBE
                  : name_is(idx, "SoundWave") ? K_SOUND : K_OTHER;
            cls_ptr[h] = cls; cls_kind[h] = (uint8_t)k;
            return k;
        }
    }
    return K_OTHER;
}

static struct { uint64_t mesh, dist, tex, snd; } freed;

// A mesh buffer (FResourceArrayInterface), recognised by its function table.
static int is_buffer(uint64_t ra) {
    if (!user_ptr(ra)) return 0;
    uint64_t vt = *(uint64_t*)ra;
    if (vt < AT(RVA_RDATA_LO) || vt >= AT(RVA_RDATA_HI)) return 0;
    uint64_t* f = (uint64_t*)vt;
    return f[2] == AT(RVA_RA_GETDATA) && f[6] == AT(RVA_RA_ALLOWCPU);
}
static void discard_buffer(uint64_t ra) {
    if (!is_buffer(ra)) return;
    if (*(uint8_t*)(ra + 0x18)) return;                  // the mesh asks to keep a CPU copy
    uint64_t* f = *(uint64_t**)ra;
    uint32_t size = ((SizeFn)f[3])((void*)ra);           // GetResourceDataSize()
    if (!size) return;
    ((DiscardFn)f[4])((void*)ra);                        // Discard()
    freed.mesh += size;
}
static void free_array(uint64_t arr) {                   // engine array: data, count, capacity
    uint64_t data = *(uint64_t*)arr;
    if (!user_ptr(data)) return;
    *(uint64_t*)arr = 0; *(uint64_t*)(arr + 8) = 0;
    ((FreeFn)AT(RVA_FMEMORY_FREE))((void*)data);
}
static uint64_t free_bulk(uint64_t rec) {                // bulk data record
    if (!user_ptr(rec)) return 0;
    uint64_t data = *(uint64_t*)(rec + 0x8);
    int64_t size = *(int64_t*)(rec + 0x10);
    uint32_t flags = *(uint32_t*)(rec + 0x20);
    if (!user_ptr(data) || size <= 0 || !(flags & BULK_ALWAYS_DISCARD) || (flags & BULK_MEMORY_MAPPED)) return 0;
    *(uint64_t*)(rec + 0x8) = 0;
    ((FreeFn)AT(RVA_FMEMORY_FREE))((void*)data);
    return (uint64_t)size;
}

static void do_mesh(uint64_t o) {
    uint64_t rd = *(uint64_t*)(o + SM_RENDERDATA);
    if (!user_ptr(rd)) return;
    uint64_t lods = *(uint64_t*)rd; int32_t n = *(int32_t*)(rd + 8);
    if (!user_ptr(lods) || n <= 0 || n > 8) return;
    for (int i = 0; i < n; i++) {
        uint64_t lod = ((uint64_t*)lods)[i];
        if (!user_ptr(lod)) continue;
        for (size_t k = 0; k < sizeof LOD_BUFFERS_INLINE / sizeof *LOD_BUFFERS_INLINE; k++) {
            if (i == 0 && LOD_BUFFERS_INLINE[k] == LOD0_INDEX) continue;
            discard_buffer(lod + LOD_BUFFERS_INLINE[k]);
        }
        for (size_t k = 0; k < sizeof LOD_BUFFERS_HELD / sizeof *LOD_BUFFERS_HELD; k++) {
            if (i == 0 && LOD_BUFFERS_HELD[k] == LOD0_POSITIONS) continue;
            uint64_t holder = *(uint64_t*)(lod + LOD_BUFFERS_HELD[k]);
            if (user_ptr(holder)) discard_buffer(holder + 8);
        }
        uint64_t df = *(uint64_t*)(lod + LOD_DISTFIELD);
        if (user_ptr(df) && *(uint64_t*)df == AT(RVA_DF_VTABLE)) {
            int32_t len = *(int32_t*)(df + 0x10);
            if (len > 0) { freed.dist += (uint64_t)len; free_array(df + 0x8); }
        }
    }
}
static void do_texture(uint64_t o, int pd_off) {
    uint64_t pd = *(uint64_t*)(o + pd_off);
    if (!user_ptr(pd)) return;
    uint64_t mips = *(uint64_t*)(pd + 0x18); int32_t n = *(int32_t*)(pd + 0x20);
    if (!user_ptr(mips) || n <= 0 || n > 16) return;
    for (int i = 0; i < n; i++) {
        uint64_t mip = ((uint64_t*)mips)[i];
        if (user_ptr(mip)) freed.tex += free_bulk(mip + 0x10);
    }
}
static void do_sound(uint64_t o) {
    uint64_t arr = *(uint64_t*)(o + SND_FORMATS); int32_t n = *(int32_t*)(o + SND_FORMATS + 8);
    if (!user_ptr(arr) || n <= 0 || n > 8) return;
    for (int i = 0; i < n; i++) freed.snd += free_bulk(((uint64_t*)arr)[2 * i + 1]);
}

static int32_t num_objects(void) { return *(int32_t*)(AT(RVA_OBJ_OBJECTS) + 0x14); }

// One pass over all loaded objects.
static void sweep(void) {
    uint64_t** chunks = *(uint64_t***)AT(RVA_OBJ_OBJECTS);
    int32_t num = num_objects();
    for (int32_t i = 0; i < num; i++) {
        uint8_t* item = (uint8_t*)chunks[i >> 16] + (size_t)(i & 0xffff) * 24;
        uint64_t o = *(uint64_t*)item;
        if (!user_ptr(o)) continue;
        if (*(uint32_t*)(item + 8) & IF_SKIP) continue;
        if (*(uint32_t*)(o + OBJ_FLAGS) & RF_SKIP) continue;
        uint64_t cls = *(uint64_t*)(o + OBJ_CLASS);
        if (!user_ptr(cls)) continue;
        switch (kind_of(cls)) {
        case K_MESH: do_mesh(o); break;
        case K_TEX2D: do_texture(o, TEX2D_PLATFORMDATA); break;
        case K_TEXCUBE: do_texture(o, TEXCUBE_PLATFORMDATA); break;
        case K_SOUND: do_sound(o); break;
        default: break;
        }
    }
}

static void log_freed(const char* when) {
    logmsg("%s: freed mesh buffers %llu MB, distance fields %llu MB, textures %llu MB, sounds %llu MB", when,
           (unsigned long long)(freed.mesh >> 20), (unsigned long long)(freed.dist >> 20),
           (unsigned long long)(freed.tex >> 20), (unsigned long long)(freed.snd >> 20));
}

// Raw Linux system call; only used when running under Wine.
static long linux_syscall3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
    return r;
}
// Moves Cozmo.dll's large static data block out of memory. Linux (Wine): madvise(MADV_PAGEOUT).
// Windows: VirtualUnlock on pages that are not locked removes them from the working set.
static void page_out_cozmo(void) {
    uint8_t* base = (uint8_t*)GetModuleHandleA("Cozmo.dll");
    if (!base) return;
    int wine = GetProcAddress(GetModuleHandleA("ntdll.dll"), "wine_get_version") != NULL;
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(base + ((IMAGE_DOS_HEADER*)base)->e_lfanew);
    IMAGE_SECTION_HEADER* sec = IMAGE_FIRST_SECTION(nt);
    for (int i = 0; i < nt->FileHeader.NumberOfSections; i++, sec++) {
        if (memcmp(sec->Name, ".data", 6) || sec->Misc.VirtualSize < (64u << 20)) continue;
        uint64_t lo = ((uint64_t)base + sec->VirtualAddress + sec->SizeOfRawData + 0xfff) & ~0xfffull;
        uint64_t hi = ((uint64_t)base + sec->VirtualAddress + sec->Misc.VirtualSize) & ~0xfffull;
        if (wine) linux_syscall3(28 /* madvise */, (long)lo, (long)(hi - lo), 21 /* MADV_PAGEOUT */);
        else VirtualUnlock((void*)lo, hi - lo);
        logmsg("Cozmo.dll static data: %llu MB moved out of memory", (unsigned long long)((hi - lo) >> 20));
    }
}

static DWORD WINAPI run(LPVOID arg) {
    // Every 2 s while the game loads, so graphics and sound data is freed as each asset finishes
    // loading. Loading is over once the object count has been large and unchanged for 15 s.
    DWORD start = GetTickCount();
    int32_t last = -1, stable = 0;
    for (;;) {
        Sleep(2000);
        int32_t n = num_objects();
        if (n > 20000) sweep();
        stable = (n == last) ? stable + 2 : 0; last = n;
        if (n > 200000 && stable >= 15 && GetTickCount() - start > 45000) break;
    }
    log_freed("map loaded");
    page_out_cozmo();
    // Assets loaded in the lobby (players' characters and outfits) are picked up by a few more
    // passes in the first minutes; none run once a match is likely under way.
    static const int later[] = { 60, 60, 60, 120, 300 };
    for (size_t i = 0; i < sizeof later / sizeof *later; i++) { Sleep(later[i] * 1000); sweep(); }
    log_freed("lobby done");
    return 0;
}

// Returns 1 when rvslim.ini lists instances and this server is not one of them.
static int instance_excluded(const char* ini) {
    char allow[512] = "";
    GetPrivateProfileStringA("rvslim", "Instances", "", allow, sizeof allow, ini);
    if (!allow[0]) return 0;
    const char* p = strstr(GetCommandLineA(), "-RVInstance=");
    char inst[64] = "";
    if (p) { p += 12; int k = 0; while (*p && *p != ' ' && *p != '"' && k < 63) inst[k++] = *p++; inst[k] = 0; }
    for (char* tok = strtok(allow, ", "); tok; tok = strtok(NULL, ", "))
        if (inst[0] && !_stricmp(tok, inst)) return 0;
    logmsg("instance %s is not listed in rvslim.ini, doing nothing", inst[0] ? inst : "(unknown)");
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(h);
    char dir[MAX_PATH], path[MAX_PATH + 16];
    GetModuleFileNameA(NULL, dir, MAX_PATH);
    char* s = strrchr(dir, '\\'); if (s) s[1] = 0;
    snprintf(path, sizeof path, "%srvslim.log", dir);
    logf = fopen(path, "a");

    char env[16];
    if (GetEnvironmentVariableA("RVSLIM", env, sizeof env) && !_stricmp(env, "off")) { logmsg("turned off (RVSLIM=off)"); return TRUE; }
    exe = (uint64_t)GetModuleHandleA(NULL);
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(exe + ((IMAGE_DOS_HEADER*)exe)->e_lfanew);
    if (nt->FileHeader.TimeDateStamp != EXE_TIMESTAMP) {
        logmsg("unknown game build (timestamp %08lx), doing nothing", nt->FileHeader.TimeDateStamp);
        return TRUE;
    }
    snprintf(path, sizeof path, "%srvslim.ini", dir);
    if (instance_excluded(path)) return TRUE;
    logmsg("started");
    CreateThread(NULL, 0, run, NULL, 0, NULL);
    return TRUE;
}
