import { motion } from "motion/react";

interface HeroSectionProps {
  subtitle?: string;
}

export function HeroSection({
  subtitle = "Generate translated captions and audio in real-time. Try for free!"
}: HeroSectionProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto max-w-3xl px-4 pt-10 text-center sm:pt-14"
    >
      <h1 className="text-4xl font-semibold tracking-normal text-gray-950 sm:text-5xl">Live Translate</h1>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-gray-500 sm:text-base">{subtitle}</p>
    </motion.section>
  );
}
