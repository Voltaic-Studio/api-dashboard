'use client';

import { motion } from 'framer-motion';
import Image from 'next/image';

export function FloatingLogo() {
  return (
    <motion.div
      animate={{ y: [0, -6, 0] }}
      transition={{ repeat: Infinity, duration: 3.5, ease: 'easeInOut' }}
      className="relative flex justify-center"
    >
      {/* Subtle glow that mirrors the logo colour */}
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-36 h-16 rounded-full pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, #FF9500 0%, transparent 70%)',
          opacity: 0.18,
          filter: 'blur(18px)',
        }}
      />
      <Image src="/logo.png" alt="ApiFlora" width={144} height={144} className="rounded-3xl relative" />
    </motion.div>
  );
}
