declare module '@getpapillon/papicons' {
  import * as React from 'react';
  export interface IconProps extends React.SVGProps<SVGSVGElement> {
    size?: number;
    color?: string;
    opacity?: number;
  }
  export const AlertCircle: React.FC<IconProps>;
  export const Archive: React.FC<IconProps>;
  export const ArrowDownBox: React.FC<IconProps>;
  export const Check: React.FC<IconProps>;
  export const Clock: React.FC<IconProps>;
  export const Cross: React.FC<IconProps>;
  export const ExternalLink: React.FC<IconProps>;
  export const Folder: React.FC<IconProps>;
  export const Gears: React.FC<IconProps>;
  export const Globe: React.FC<IconProps>;
  export const Info: React.FC<IconProps>;
  export const Link: React.FC<IconProps>;
  export const List: React.FC<IconProps>;
  export const Play: React.FC<IconProps>;
  export const Plus: React.FC<IconProps>;
  export const Search: React.FC<IconProps>;
  export const Volume: React.FC<IconProps>;
}
