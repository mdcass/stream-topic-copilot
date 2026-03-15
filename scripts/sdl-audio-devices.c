#include <SDL.h>
#include <stdio.h>
#include <string.h>

static void print_json_escaped(const char *value) {
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *) value; *cursor != '\0'; ++cursor) {
        switch (*cursor) {
            case '\\':
            case '"':
                putchar('\\');
                putchar(*cursor);
                break;
            case '\n':
                fputs("\\n", stdout);
                break;
            case '\r':
                fputs("\\r", stdout);
                break;
            case '\t':
                fputs("\\t", stdout);
                break;
            default:
                putchar(*cursor);
                break;
        }
    }
    putchar('"');
}

int main(void) {
    if (SDL_Init(SDL_INIT_AUDIO) != 0) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    const int count = SDL_GetNumAudioDevices(SDL_TRUE);
    putchar('[');
    for (int index = 0; index < count; ++index) {
        const char *name = SDL_GetAudioDeviceName(index, SDL_TRUE);
        if (index > 0) {
            putchar(',');
        }

        printf("{\"id\":\"%d\",\"name\":", index);
        print_json_escaped(name ? name : "Unknown input");
        printf(",\"isDefault\":false}");
    }
    puts("]");

    SDL_Quit();
    return 0;
}
