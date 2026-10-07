/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Celiador emblem silhouette path, matching resources/celiador/celiador-emblem.svg.
// The aquarium cannot use that SVG file directly because each fish renders the
// logo as live, same-document SVG geometry: fish.ts stores this path in a
// shared <symbol>, then renders clipped <use> slices with staggered CSS
// animations. That keeps the swimming-strip effect, currentColor species
// tinting, and auxiliary-window support while avoiding duplicate path parsing
// per fish.
export const CELIADOR_LOGO_PATH = 'M47 10.8L12.6 37.5Q10 39.5 10 42.8V53.2Q10 56.5 12.6 58.5L47 85.2V69.2L22 48L47 26.8ZM49 10.8L83.4 37.5Q86 39.5 86 42.8V53.2Q86 56.5 83.4 58.5L49 85.2V69.2L74 48L49 26.8ZM48 38.5A9.5 9.5 0 1 0 48 57.5A9.5 9.5 0 1 0 48 38.5Z';
