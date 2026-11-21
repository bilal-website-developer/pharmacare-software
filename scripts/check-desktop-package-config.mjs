const requiredVariables = ['CENTRAL_API_URL', 'CENTRAL_LICENSE_PUBLIC_KEY'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim());

if (missingVariables.length > 0) {
  console.error(
    `Cannot package Pharma Care: set ${missingVariables.join(' and ')} before running npm run desktop:package.`,
  );
  process.exit(1);
}
