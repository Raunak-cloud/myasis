/**
 * Types for noVNC, which ships as plain JavaScript with no declarations.
 *
 * Only the surface the SEEK sign-in viewer uses is declared. Written by hand
 * rather than pulled from DefinitelyTyped because no package exists for it.
 */
declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, urlOrSocket: string | WebSocket, options?: RFBOptions);
    /** Scale the remote screen to fit the container. */
    scaleViewport: boolean;
    /** Resize the remote screen to the container instead of scaling. */
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendCtrlAltDel(): void;
  }
}
