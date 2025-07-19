const fs = require('fs');
const path = require('path');

// Load commands that need dependency injection
function loadCommands(dependencies = {}) {
    const commands = new Map();

    const commandFiles = fs.readdirSync(__dirname).filter(file => 
        file.endsWith('.js') && file !== 'index.js'
    );

    for (const file of commandFiles) {
        const filePath = path.join(__dirname, file);
        const command = require(filePath);
        
        if ('data' in command && 'execute' in command) {
            // For commands that need dependencies, wrap the execute function
            if (['stop', 'transcribe'].includes(command.data.name)) {
                commands.set(command.data.name, {
                    data: command.data,
                    execute: (interaction) => command.execute(interaction, dependencies)
                });
            } else {
                commands.set(command.data.name, command);
            }
        } else {
            console.warn(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }

    return commands;
}

module.exports = { loadCommands };