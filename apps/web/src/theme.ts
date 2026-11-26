import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Audit-ink blue, the one accent. Index 6 is #2F5BEA.
const ink: MantineColorsTuple = ['#eef2fe', '#dbe3fc', '#b4c4f7', '#8aa3f2', '#6787ee', '#4f74eb', '#2f5bea', '#2149d0', '#1a40bb', '#0f35a5'];
const navy: MantineColorsTuple = ['#eef1f7', '#dce1ec', '#b6c1d8', '#8e9fc4', '#6d82b3', '#5870a9', '#4c66a5', '#3d5590', '#334b81', '#17233f'];
const stalled: MantineColorsTuple = ['#f2f0f8', '#e1ddee', '#c0b8dd', '#9d90cc', '#8070be', '#6e5cb6', '#6552b3', '#54439d', '#4a3b8d', '#3e317d'];

export const theme = createTheme({
  primaryColor: 'ink',
  primaryShade: 6,
  colors: { ink, navy, stalled },
  black: '#17233F',
  fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, monospace',
  headings: {
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
    fontWeight: '600',
    sizes: { h1: { fontSize: '1.6rem', lineHeight: '1.25' }, h2: { fontSize: '1.25rem', lineHeight: '1.3' }, h3: { fontSize: '1.05rem', lineHeight: '1.35' } },
  },
  defaultRadius: 'md',
  radius: { xs: '3px', sm: '5px', md: '8px', lg: '12px', xl: '16px' },
  fontSizes: { xs: '0.75rem', sm: '0.84rem', md: '0.94rem', lg: '1.05rem', xl: '1.2rem' },
  cursorType: 'pointer',
  components: {
    Paper: { defaultProps: { withBorder: true, radius: 'md' } },
    Badge: { defaultProps: { radius: 'sm', variant: 'light' }, styles: { root: { textTransform: 'none', fontWeight: 500, letterSpacing: 0 } } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 150 } },
  },
});
