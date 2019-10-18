import {Registers} from './Registers.js'
import {Memory} from './Memory.js'
import {IOBuffer} from './IOBuffer.js';
import {Loader} from '../Loaders/Loader.js';

export class CPUError extends Error {}

/**
 *  Small x86_64 emulator with a couple of registers implemented and
 *      dynamically sized memory region.
 */
export class CPU {
    /**
     * Sets up the CPU, it's registers, memory, etc.
     *
     * @param memorySize Size of memory in bytes.
     */
    constructor(memorySize) {
        this.registers = new Registers();
        this.memory = new Memory(memorySize);
        this.codeSize = 0x0;

        this.registers.setReg("RIP", 0x0);
        this.registers.setReg("RSP", memorySize);

        this.onEndCallbacks = [];

        // Initializes the Capstone engine. Is used throughout the "CPU"
        // It's just easier to emulate based on simple mnemonics rather than opcodes.
        this.disassembler = new cs.Capstone(cs.ARCH_X86, cs.MODE_64);

        this.done = false;

        this.ioBuffer = new IOBuffer();

        window.onerror = (msg, url, lineNo, columnNo, error) => {

            if (error instanceof CPUError) {
                this.done = true;
                this.ioBuffer.output(msg + "\n");
            }

            return false;
        }
    }

    /**
     * Public API for loading code into memory.
     *
     * @param code Byte array of code.
     */
    loadCode(code) {
        this.memory.store(0, code);
        this.codeSize = code.length;
    }

    /**
     * Returns full disassembled binary code.
     *
     * @returns {Array} Array of instructions (mnemonic and op str)
     */
    fullDisassembledCode() {
        let instructions = this.disassembler.disasm(this.memory.load(0x0, this.codeSize), 0x0);

        let disassembled = [];

        // TODO: Could like flatMap or whatever? I use maps way too little :(
        instructions.forEach((instruction) => {
            disassembled.push([instruction.address.toString(16), instruction.mnemonic, instruction.op_str]);
        });

        return disassembled;
    }

    /**
     * Returns full disassembled binary code.
     *
     * @returns {Array} Array of instructions (mnemonic and op str)
     */
    disassembly(memoryStartOffset, memoryEndOffset, vmOffset = 0x0) {
        let instructions = this.disassembler.disasm(this.memory.load(memoryStartOffset, memoryEndOffset), vmOffset);

        let disassembled = [];

        // TODO: Could like flatMap or whatever? I use maps way too little :(
        instructions.forEach((instruction) => {
            disassembled.push([instruction.address.toString(16), instruction.mnemonic, instruction.op_str]);
        });

        return disassembled;
    }

    /**
     * Steps through the code.
     */
    nextInstruction() {
        if (this.done === true) {
            return;
        }

        this.doNotProgress = false;

        let instructionPointer = this.registers.reg("RIP");

        // Disassemble one instruction off memory
        let instruction = this.disassembler.disasm(
            this.memory.load(instructionPointer, 32),
            instructionPointer, 0x1
        )[0];

        if (instruction === undefined) {
            throw new CPUError(`Can not disassemble instruction at address ${instructionPointer}!`);
        }

        if (this.trackInstructions !== undefined) {
            console.log(`📌 ${instruction.address.toString(16)}: ${instruction.mnemonic}\t${instruction.op_str}`);
        }

        // Progress instruction pointer
        instructionPointer += instruction.size;
        this.registers.setReg("rip", instructionPointer);

        let ih = new InstructionHandler(this, instruction.op_str, instruction.size);

        switch(instruction.mnemonic) {
            case "mov": ih.mov(); break;
            case "movabs": ih.mov(); break;
            case "lea": ih.lea(); break;
            case "jmp": ih.jmp(); break;
            case "push": ih.push(); break;
            case "pop": ih.pop(); break;
            case "call": ih.call(); break;
            case "ret": ih.ret(); break;
            case "int": ih.int(); break;
            case "sub": ih.sub(); break;
            case "add": ih.add(); break;
            case "je": ih.je(); break;
            case "jne": ih.jne(); break;
            case "cmp": ih.cmp(); break;
            default: throw new CPUError(`Unknown mnemonic: ${instruction.mnemonic}`);
        }
    }

    onEnd(callback) {
        this.onEndCallbacks.push(callback);
    }

    ended(reason) {
        this.onEndCallbacks.forEach((callback) => {
            callback(reason);
        });
    }
}

/**
 * Class for handling instructions.
 * It's just way easier to split it into its own class,
 *  so we don't have to deal with a bunch of dumb functions
 *  in the CPU-class.
 */
class InstructionHandler {
    constructor(cpu, op_str, inst_size = 0) {
        this.cpu = cpu;
        this.op_str = op_str;
        this.inst_size = inst_size;  // Important for functions that control RIP
    }

    /**
     * Horribly badly parses (mostly right-side) instruction ops.
     *
     * Doesn't handle any arithmetic, cuz for a moment I forgot that was a thing.
     *
     * @param val Value to parse
     * @returns {{size: number, value: (number)}} <-- That
     */
    parseValue(val) {
        var value = 0x0;
        var valueSize = 0x0;
        var address = null;
        var name = null;

        if (isNaN(val)) {
            if (val.includes("ptr")) {
                var size = 0x8;

                let components = val.split(" ");

                let sizeDefinition = components[0];
                let ptr = components[1];
                /*address = components[2]
                    .replace("[", "")
                    .replace("]", "");*/

                switch(sizeDefinition) {
                    case "qword": size = 0x8; break;
                    case "dword": size = 0x4; break;
                    case "word":  size = 0x2; break;
                    case "byte":  size = 0x1; break;
                }

                // Resolve address
                let addressComponents = val.split("[")[1].split("]")[0].split(" ");
                address = 0;
                var operation = "+";

                addressComponents.forEach((component) => {
                    var realValue = 0;

                    if (component === "+" || component === "-" || component === "*" || component === "/") {
                        operation = component;
                    } else if (isNaN(component)) { // Assume it's a register
                        name = component;
                        realValue = this.cpu.registers.reg(component);
                    } else {
                        realValue = parseInt(component);
                    }

                    switch(operation) {
                        case "+": address += realValue; break;
                        case "-": address -= realValue; break;
                        case "*": address *= realValue; break;
                        case "/": address /= realValue; break;
                    }
                });

                value = this.cpu.memory.loadUInt(address, size);
                valueSize = size;
            } else { // Assume val is a register
                name = val;
                value = this.cpu.registers.reg(val);
                valueSize = this.cpu.registers.regByteLen(val);
            }
        } else {
            value = parseInt(val);
            valueSize = 0x8;
        }

        return {"value": value, "size": valueSize, "address": address, "name": name};
    }

    /**
     * MOV-instruction. Works exactly like Intel specced it, I promise. /s
     */
    mov() {
        let sides = this.op_str.split(",");
        let left = sides[0].trim();
        let right = sides[1].trim();

        // --- Parse right side --- //
        right = this.parseValue(right);

        // --- Parse left side --- //
        if (!left.includes("ptr")) { // Left is just a register. I hope.
            this.cpu.registers.setReg(left, right.value);
        } else {
            left = this.parseValue(left);
            this.cpu.memory.store(left.address, right.value, left.size);
        }
    }

    lea() {
        let sides = this.op_str.split(",");
        let left = sides[0].trim();
        let right = sides[1].trim();

        // --- Parse right side --- //
        right = this.parseValue(right);

        // --- Parse left side --- //
        if (!left.includes("ptr")) { // Left is just a register. I hope.
            this.cpu.registers.setReg(left, right.address);
        } else {
            left = this.parseValue(left);
            this.cpu.memory.store(left.address, right.address, left.size);
        }
    }

    /**
     * JMPs to address
     */
    jmp() {
        let address = this.parseValue(this.op_str);

        if (address.value > this.cpu.memory.size) {
            throw CPUError("Can not jump to address: " + address.value.toString(16));
        }

        this.cpu.registers.setReg("RIP", address.value);
    }

    /*
    * Conditional jumping
     */
    je() {
        if (this.cpu.registers.flag("ZF")) {
            this.jmp();
        }
    }

    jne() {
        if (!this.cpu.registers.flag("ZF")) {
            this.jmp();
        }
    }

    /*
     *  cmp is basically sub, but without the side effect, apparently.
     */
    cmp() {
        let components = this.op_str.split(",");

        let left = this.parseValue(components[0]);
        let right = this.parseValue(components[1]);
        let newValue = (left.value - right.value) % (2 ^ (left.size * 8));

        // Set relevant flags
        this.cpu.registers.setFlag("ZF", newValue === 0);
        this.cpu.registers.setFlag("SF", newValue < 0);
        this.cpu.registers.setFlag("CF", (left.value - right.value) > 2 ^ (left.size * 8));
        this.cpu.registers.setFlag("PF", !(newValue % 2));
        this.cpu.registers.setFlag("OF", left.value !== newValue + right.value || right.value !== -newValue + left.value)
        // TODO: Set Auxiliary flag if relevant
    }

    /**
     * Pushes
     */
    push() {
        let value = this.parseValue(this.op_str);

        let rsp = this.cpu.registers.reg("rsp") - value.size;
        this.cpu.registers.setReg("rsp", rsp);

        let memValue = value.value.toString(16)
            .padStart(value.size * 2, "0")
            .match(/.{1,2}/g)
            .map((val) => {
                return parseInt(val, 16);
            }
        );

        this.cpu.memory.store(rsp, memValue);
    }

    /**
     * P0P P0P!
     *  https://www.youtube.com/watch?v=dyp9Qw12boI
     */
    pop() {
        let register = this.op_str;
        let size = this.cpu.registers.regByteLen(this.op_str);

        let rsp = this.cpu.registers.reg("rsp");

        let memValue = this.cpu.memory.loadUInt(rsp, size);

        if (memValue.toNumber(true) >= Infinity) {
            throw new CPUError(`Can not pop 0x${memValue.toOctetString()} into ${register}. It is too large for this emulator to handle.`);
        }

        this.cpu.registers.setReg("rsp", rsp + size);
        this.cpu.registers.setReg(register, memValue.toNumber(true));
    }

    /**
     * Pushes and jumps like a rude kid. Damn it's annoying when kids are rude and parents are just
     *  obviously ignoring it. grr.
     */
    call() {
        let newRip = this.cpu.registers.reg("rip");
        this.cpu.registers.setReg("rip", newRip);

        let ih = new InstructionHandler(this.cpu, "rip");
        ih.push();

        ih = new InstructionHandler(this.cpu, this.op_str);
        ih.jmp();
    }

    sub() {
        let components = this.op_str.split(",");

        let register = this.parseValue(components[0]);
        let right = this.parseValue(components[1]);
        let newValue = (register.value - right.value) % Math.pow(2, (register.size * 8));

        // Set relevant flags
        this.cpu.registers.setFlag("ZF", newValue === 0);
        this.cpu.registers.setFlag("SF", newValue < 0);
        this.cpu.registers.setFlag("CF", (register.value - right.value) > Math.pow(2, (register.size * 8)));
        this.cpu.registers.setFlag("PF", !(newValue % 2));
        this.cpu.registers.setFlag("OF", register.value !== newValue + right.value || right.value !== -newValue + register.value)
        // TODO: Set Auxiliary flag if relevant

        this.cpu.registers.setReg(register.name, newValue);
    }

    add() {
        let components = this.op_str.split(",");

        let register = this.parseValue(components[0]);
        let right = this.parseValue(components[1]);
        let newValue = (register.value + right.value) % Math.pow(2, (register.size * 8));

        // Set relevant flags
        this.cpu.registers.setFlag("ZF", newValue === 0);
        this.cpu.registers.setFlag("SF", newValue < 0);
        this.cpu.registers.setFlag("CF", (register.value + right.value) > Math.pow(2, (register.size * 8)));
        this.cpu.registers.setFlag("PF", !(newValue % 2));
        this.cpu.registers.setFlag("OF", register.value !== newValue - right.value || right.value !== newValue - register.value)
        // TODO: Set Auxiliary flag if relevant

        this.cpu.registers.setReg(register.name, newValue);
    }

    /**
     * Pops and jumps like something that pops and jumps.
     */
    ret() {
        let ih = new InstructionHandler(this.cpu, "rip");
        ih.pop();

        ih = new InstructionHandler(this.cpu, this.cpu.registers.reg("rip"));
        ih.jmp();
    }

    /**
     * Int-instructions are repurposed to call "native" JavaScript functions
     * (Calling JavaScript functions "native" hurts my soul, but they're more native than an emulated CPU tbh)
     */
    int() {
        let value = this.parseValue(this.op_str);

        let nativeFunction = new NativeFunction(this.cpu);

        switch(value.value) {
            case 1: nativeFunction.alert(); break;
            case 2: nativeFunction.getInput(); break;
            case 3: nativeFunction.exit(); break;
            case 4: nativeFunction.printf(); break;
            case 5: nativeFunction.restart(); break;
            case 6: nativeFunction.call(); break;
        }
    }
}

/**
 * JavaScript functions that we tie into the emulator.
 */
class NativeFunction {
    constructor(cpu) {
        this.cpu = cpu;
    }

    alert() {
        let memoryPointer = this.cpu.registers.reg("rdi");

        let message = this.cpu.memory.loadString(memoryPointer, 0x00);

        message = message.substring(0, message.length);

        this.cpu.ioBuffer.output(message);
        alert(message);
    }

    getInput() {
        let memoryPointer = this.cpu.registers.reg("rdi");
        let maxSize = this.cpu.registers.reg("rsi");

        let input = this.cpu.ioBuffer.getNextInput();

        if (input === false) {
            this.cpu.doNotProgress = true;
            return;
        }

        if (input.length > maxSize) {
            input = input.substr(0, maxSize);
        }

        let encoder = new TextEncoder('utf-8');
        this.cpu.memory.store(memoryPointer, encoder.encode(input));
    }

    // TODO: Actually tear down CPU and stuff.
    exit() {
        console.log("Instruction end");
        this.cpu.ioBuffer.output("Finished running program.");
        this.cpu.done = true;

        this.cpu.ended("end");
    }

    restart() {
        console.log("Instruction end");
        this.cpu.ioBuffer.output("Finished running program.");
        this.cpu.done = true;

        this.cpu.ended("restart");
    }

    /**
     * lol, we're cheating like crazy here
     */
    printf() {
        let formatPointer = this.cpu.registers.reg("rdi");
        let argumentPointer = this.cpu.registers.reg("rax");

        let format = this.cpu.memory.loadString(formatPointer, 0x00);
        let argument = this.cpu.memory.loadString(argumentPointer, 0x00).trim();

        this.cpu.ioBuffer.output(format.replace("%s", argument));
    }

    /**
     *
     */
    call() {
        let symbolNamePointer = this.cpu.registers.reg("rdi");
        let libraryNamePointer = this.cpu.registers.reg("rax");

        let symbolName = this.cpu.memory.loadString(symbolNamePointer, 0x00);
        let libraryName = this.cpu.memory.loadString(libraryNamePointer, 0x00);

        let library = new (Loader.getLibrary(libraryName))(this.cpu);

        library[symbolName]();
    }
}